import { passageUrl } from '../source-link';
import { z } from 'zod';
import { launchFailure } from './launch-error';
import { LocalMessageSchema } from '../../../../packages/contracts/src';
import { shareableUrl, actionPolicy } from '../../../../packages/security/src';
declare const __CMD_F_API__: string;
const apiBase = typeof __CMD_F_API__ === 'string' ? __CMD_F_API__ : 'http://127.0.0.1:4317';
const ApiPath = z.string().regex(/^\/v1(?:\/[A-Za-z0-9_-]+)*$/);
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  void chrome.storage.session.set({ sourceTabId: tab.id });
  void chrome.scripting
    .executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      files: ['overlay-host.js'],
    })
    .catch((error: unknown) => {
      const reason = launchFailure(tab.url, error);
      void chrome.tabs.create({ url: chrome.runtime.getURL(`overlay.html?unavailable=${reason}`) });
    });
});
const Envelope = z.object({ tabId: z.number().int().nonnegative(), operation: LocalMessageSchema });
chrome.runtime.onMessage.addListener((raw, sender, respond) => {
  const overlayHtml = sender.url === chrome.runtime.getURL('overlay.html');
  const panel = sender.url === chrome.runtime.getURL('sidepanel.html');
  const overlay = overlayHtml || (!!sender.tab?.id && /^https?:/i.test(sender.url || ''));
  if (sender.id !== chrome.runtime.id || (!panel && !overlay)) return;
  const run = async () => {
    if (raw?.type === 'API_FETCH') {
      try {
        const path = ApiPath.parse(raw.path);
        const method = z.enum(['GET', 'POST', 'DELETE']).parse(raw.method || 'GET');
        const token = z.string().min(24).parse(raw.token);
        const r = await fetch(`${apiBase}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(raw.body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: raw.body ? JSON.stringify(raw.body) : undefined,
          signal: AbortSignal.timeout(10000),
        });
        return { status: r.status, json: await r.json().catch(() => ({})) };
      } catch {
        return { unavailable: true };
      }
    }
    if (overlay && raw?.type === 'RESIZE_OVERLAY') {
      const height = z.number().finite().min(50).max(1000).parse(raw.height);
      return chrome.tabs.sendMessage(
        sender.tab!.id!,
        { type: 'RESIZE_OVERLAY', height },
        { frameId: 0 },
      );
    }
    if (overlay && raw?.type === 'CLOSE_OVERLAY') {
      return chrome.tabs.sendMessage(sender.tab!.id!, { type: 'CLOSE_OVERLAY' }, { frameId: 0 });
    }
    if (raw?.type === 'SOURCE') {
      if (overlay) {
        const tab = await chrome.tabs.get(sender.tab!.id!);
        return {
          tabId: tab.id,
          url: shareableUrl(tab.url || ''),
          title: tab.title,
          viewportHeight: tab.height,
        };
      }
      const saved = await chrome.storage.session.get('sourceTabId');
      if (typeof saved.sourceTabId === 'number') {
        try {
          const tab = await chrome.tabs.get(saved.sourceTabId);
          return { tabId: tab.id, url: shareableUrl(tab.url || ''), title: tab.title };
        } catch {
          /* tab closed */
        }
      }
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id || !tab.url?.startsWith('http'))
        throw new Error('Open a website and click the Cmd-F toolbar button.');
      await chrome.storage.session.set({ sourceTabId: tab.id });
      return { tabId: tab.id, url: shareableUrl(tab.url), title: tab.title };
    }
    if (raw?.type === 'OPEN_SOURCE') {
      const url = z.string().url().parse(raw.url);
      const safe = shareableUrl(url);
      if (!safe || actionPolicy(safe) !== 'read_candidate')
        throw new Error('Use the existing website control directly.');
      const quote = z.string().max(10000).optional().parse(raw.quote);
      await chrome.tabs.create({ url: passageUrl(safe, quote) });
      return { ok: true };
    }
    const msg = Envelope.parse(raw);
    if (overlay && msg.tabId !== sender.tab!.id) throw new Error('Wrong source tab');
    const tab = await chrome.tabs.get(msg.tabId);
    if (!tab.url?.startsWith('http')) throw new Error('This page cannot be inspected.');
    if (msg.operation.type === 'INSPECT')
      await chrome.scripting.executeScript({
        target: { tabId: msg.tabId, frameIds: [0] },
        files: ['content.js'],
      });
    return await chrome.tabs.sendMessage(msg.tabId, msg.operation, { frameId: 0 });
  };
  run()
    .then(respond)
    .catch(() =>
      respond({
        error:
          'Cmd-F could not access this page. Click its toolbar button on the source tab and try again.',
      }),
    );
  return true;
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'cmd-f-events' || port.sender?.id !== chrome.runtime.id) return;
  const abort = new AbortController();
  port.onDisconnect.addListener(() => abort.abort());
  port.onMessage.addListener((raw) => {
    void (async () => {
      try {
        const { id, token, cursor } = z
          .object({
            id: z
              .string()
              .min(1)
              .max(80)
              .regex(/^[A-Za-z0-9_-]+$/),
            token: z.string().min(24),
            cursor: z.number().int().nonnegative(),
          })
          .parse(raw);
        const response = await fetch(`${apiBase}/v1/searches/${id}/events`, {
          headers: { Authorization: `Bearer ${token}`, 'Last-Event-ID': String(cursor) },
          signal: abort.signal,
        });
        if (!response.ok || !response.body) {
          port.postMessage({ error: 'Search event connection failed.' });
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!abort.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 1_000_000) throw new Error('Event too large');
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (block.includes('data: ')) port.postMessage({ block });
          }
        }
      } catch (error) {
        if (!abort.signal.aborted)
          port.postMessage({
            error:
              error instanceof Error && error.message === 'Event too large'
                ? error.message
                : 'Search event connection failed.',
          });
      } finally {
        try {
          port.disconnect();
        } catch {
          /* already disconnected */
        }
      }
    })();
  });
});

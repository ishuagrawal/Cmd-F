import { z } from 'zod';
import { launchFailure } from './launch-error';
import { LocalMessageSchema } from '../../../../packages/contracts/src';
import { shareableUrl, actionPolicy } from '../../../../packages/security/src';
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
  const overlay =
    sender.url === chrome.runtime.getURL('overlay.html') && typeof sender.tab?.id === 'number';
  const panel = sender.url === chrome.runtime.getURL('sidepanel.html');
  if (sender.id !== chrome.runtime.id || (!panel && !overlay)) return;
  const run = async () => {
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
      await chrome.tabs.create({ url: safe });
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

import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUp, ArrowUpRight, Command, Cursor, GearSix, X, Stop } from '@phosphor-icons/react';
import { z } from 'zod';
import {
  PROTOCOL,
  SnapshotSchema,
  StateSchema,
  type PageSnapshot,
  type SearchState,
  type EvidenceResult,
} from '../../../../packages/contracts/src';
import { actionPolicy, shareableUrl } from '../../../../packages/security/src';
import { Api } from '../sidepanel/api';
import { inspect, isExtension, local, openSource, source } from '../sidepanel/bridge';
import {
  bakedClientToken,
  isAuthTokenError,
  readClientToken,
  saveClientToken,
} from '../sidepanel/client-token';
import './style.css';

function Chat() {
  const [question, setQuestion] = useState(() => {
    const draft = sessionStorage.getItem('cmd-f-reconnect-draft') || '';
    sessionStorage.removeItem('cmd-f-reconnect-draft');
    return draft;
  });
  const [scope, setScope] = useState<'page' | 'site'>('site');
  const [token, setToken] = useState('');
  const [settings, setSettings] = useState(false);
  const [connected, setConnected] = useState(false);
  const [provider, setProvider] = useState('');
  const [host, setHost] = useState('This page');
  const [error, setError] = useState('');
  const [state, setState] = useState<SearchState>();
  const [asked, setAsked] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<{ question: string; response: string }[]>([]);
  const api = useRef(new Api(import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:4317', ''));
  const src = useRef(0);
  const snapshot = useRef<PageSnapshot | undefined>(undefined);
  const current = useRef<SearchState | undefined>(undefined);
  const stream = useRef<AbortController | undefined>(undefined);
  const reading = useRef(false);
  const submitting = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const measure = useRef<HTMLElement>(null);
  const expanded = !!(
    settings ||
    asked ||
    busy ||
    state ||
    error ||
    history.length ||
    new URLSearchParams(location.search).has('unavailable')
  );
  const log = useRef<HTMLDivElement>(null);
  const running = busy || state?.lifecycle === 'running';
  const sources =
    state?.results.filter(
      (r) =>
        (r.evidence === 'direct' && r.provider !== 'lexical_fallback') ||
        (r.kind === 'listing' && r.evidence === 'candidate_only'),
    ) || [];
  const unavailable = new URLSearchParams(location.search).has('unavailable');

  useEffect(() => {
    const root = measure.current;
    if (!root || !isExtension) return;
    const observer = new ResizeObserver(() => {
      void chrome.runtime
        .sendMessage({
          type: 'RESIZE_OVERLAY',
          height: Math.ceil(root.getBoundingClientRect().height) + 8,
        })
        .catch(() => {});
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  async function connect(value: string, fallback = true) {
    api.current = new Api(import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:4317', value);
    setConnected(false);
    try {
      const cfg = z
        .object({ provider: z.string(), transport: z.string().optional() })
        .parse(await api.current.call('/v1/config'));
      setProvider(
        cfg.provider === 'mock'
          ? 'Demo keyword provider'
          : cfg.transport === 'gateway'
            ? 'Vercel AI Gateway and TypeSafe/Jev'
            : 'TypeSafe/Jev',
      );
      setConnected(true);
      setSettings(false);
      setError('');
    } catch (e) {
      const baked = bakedClientToken();
      if (fallback && baked && baked !== value && isAuthTokenError(e)) {
        await saveClientToken('');
        setToken(baked);
        await connect(baked, false);
        return;
      }
      setError((e as Error).message);
      setSettings(true);
    }
  }
  function cleanup() {
    stream.current?.abort();
    if (current.current) void api.current.close(current.current.id);
    void local(src.current, { type: 'CLEAR' }).catch(() => {});
    void local(src.current, { type: 'STOP' }).catch(() => {});
  }
  async function close() {
    cleanup();
    if (isExtension) await chrome.runtime.sendMessage({ type: 'CLOSE_OVERLAY' });
    else location.href = '/sidepanel.html';
  }
  useEffect(() => {
    if (unavailable) return;
    void (async () => {
      try {
        const t = await readClientToken();
        if (t) {
          setToken(t);
          await connect(t);
        } else setSettings(true);
        const page = await source();
        measure.current?.style.setProperty(
          '--response-height',
          `${Math.max(140, (page.viewportHeight || 700) - 130)}px`,
        );
        src.current = page.tabId;
        setHost(page.url ? new URL(page.url).hostname : 'Current page');
        input.current?.focus();
      } catch {
        setError('Could not connect to this page. Reopen Cmd-F with the shortcut.');
      }
    })();
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void close();
      }
    };
    window.addEventListener('keydown', escape);
    window.addEventListener('pagehide', cleanup);
    return () => {
      window.removeEventListener('keydown', escape);
      window.removeEventListener('pagehide', cleanup);
      cleanup();
    };
  }, []);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'instant' });
  }, [asked, error, history]);
  useEffect(() => {
    if (!state?.id) return;
    const id = state.id;
    const lease = setInterval(
      () => void api.current.call(`/v1/searches/${id}/lease`, 'POST').catch(() => {}),
      15000,
    );
    return () => clearInterval(lease);
  }, [state?.id]);
  async function receive(next: SearchState) {
    if (current.current?.id !== next.id) return;
    current.current = next;
    setState(next);
    if (next.requestedSections.length && !reading.current) {
      const snap = snapshot.current;
      if (!snap || next.requestedSections.some((id) => !snap.sectionIds.includes(id))) {
        setError('The requested section is no longer in the search snapshot. Please search again.');
        return;
      }
      reading.current = true;
      try {
        snapshot.current = SnapshotSchema.parse(
          await local(src.current, {
            type: 'READ_SECTION',
            snapshotId: snap.id,
            sectionIds: next.requestedSections,
          }),
        );
        await api.current.resume(next.id, snapshot.current);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        reading.current = false;
      }
    }
    if (['completed', 'failed', 'cancelled'].includes(next.lifecycle))
      void local(src.current, { type: 'STOP' }).catch(() => {});
  }
  function reconnect() {
    sessionStorage.setItem('cmd-f-reconnect-draft', question || asked);
    location.reload();
  }
  async function submit() {
    const query = question.trim();
    if (query.length < 2 || running || submitting.current || !connected) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      if (asked && state)
        setHistory((h) => [...h.slice(-4), { question: asked, response: summary(state) }]);
      cleanup();
      current.current = undefined;
      setState(undefined);
      setAsked(query);
      const page = await source();
      src.current = page.tabId;
      const snap = await inspect(page.tabId, query);
      snapshot.current = snap;
      const next = await api.current.create({
        protocol: PROTOCOL,
        question: query,
        snapshot: snap,
        scope,
        consent: true,
        publicSearchConsent: scope === 'site',
        refresh: false,
      });
      setQuestion('');
      current.current = next;
      setState(next);
      const ctrl = new AbortController();
      stream.current = ctrl;
      void api.current
        .events(next.id, ctrl.signal, (s) => void receive(s))
        .catch((e) => {
          if (!ctrl.signal.aborted) {
            setError((e as Error).message);
            setBusy(false);
            void api.current.close(next.id);
            current.current = undefined;
            setState((s) => (s ? { ...s, lifecycle: 'failed' } : s));
          }
        });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function stop() {
    if (!state) return;
    stream.current?.abort();
    try {
      const next = StateSchema.parse(
        await api.current.call(`/v1/searches/${state.id}/cancel`, 'POST'),
      );
      current.current = next;
      setState(next);
    } catch (e) {
      setError((e as Error).message);
    }
    void local(src.current, { type: 'STOP' }).catch(() => {});
  }
  async function show(result: EvidenceResult) {
    setError('');
    try {
      await local(src.current, {
        type: 'SHOW',
        snapshotId: result.snapshotId,
        documentId: result.documentId,
        candidateId: result.candidate.id,
        excerpt: result.excerpt,
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section ref={measure} className="chat" role="dialog" aria-label="Cmd-F chat">
      <div className="conversation" ref={log} role="log" aria-live="polite" hidden={!expanded}>
        <div className="context">
          <span>{host}</span>
          <select
            aria-label="Search scope"
            value={scope}
            disabled={running}
            onChange={(e) => setScope(e.target.value as 'page' | 'site')}
          >
            <option value="site">This site</option>
            <option value="page">This page</option>
          </select>
        </div>
        {unavailable ? (
          <div className="reply error">
            This browser page cannot be inspected. Open a regular website, then press the Cmd-F
            shortcut or click its toolbar icon.
          </div>
        ) : (
          <>
            {settings && (
              <form
                className="setup"
                onSubmit={(e) => {
                  e.preventDefault();
                  void (async () => {
                    const next = token.trim() || bakedClientToken();
                    setToken(next);
                    await saveClientToken(next);
                    await connect(next, false);
                  })();
                }}
              >
                <h2>Connect to the local backend</h2>
                <p>
                  Keep the local backend running with <code>pnpm dev:api</code>. This build already
                  includes the machine-local connection token.
                </p>
                <p>
                  Submitting a request searches this page and, with This site selected, public pages
                  on this site and relevant linked websites. Your query and selected page text go to
                  the local backend
                  {provider && provider !== 'Demo keyword provider' ? ` and ${provider}` : ''}. Form
                  values and drafts are excluded.
                </p>
                <label htmlFor="connection">Local client token</label>
                <input
                  id="connection"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Optional override"
                />
                <p>
                  Change this only if you replaced the backend token. It is not your provider API
                  key.
                </p>
                <button className="primary" type="submit">
                  Connect
                </button>
              </form>
            )}
            {history.map((turn, i) => (
              <React.Fragment key={i}>
                <div className="user-message">{turn.question}</div>
                <p className="reply">{turn.response}</p>
              </React.Fragment>
            ))}
            {asked && <div className="user-message">{asked}</div>}
            {busy && !state && (
              <p className="reply" role="status">
                Searching…
              </p>
            )}
            {state && (
              <>
                <div className="coverage" aria-label="Search coverage">
                  <span>
                    {state.coverage.pagesChecked}{' '}
                    {state.coverage.pagesChecked === 1 ? 'page' : 'pages'} checked
                  </span>
                  <span>{state.coverage.linksObserved ?? 0} links seen</span>
                  <span>{(state.coverage.elapsedMs / 1000).toFixed(1)}s</span>
                </div>
                {sources.some((r) => r.kind === 'listing') && (
                  <p className="listing-note">Destination details not verified.</p>
                )}
                {sources.map((r) => (
                  <article
                    className={`source ${r.kind === 'listing' ? 'listing' : 'passage'}`}
                    key={r.id}
                  >
                    <span className="eyebrow">
                      {r.kind === 'listing'
                        ? 'MATCHING LISTING'
                        : r.provider === 'mock'
                          ? 'DEMO MATCH'
                          : 'SOURCE FOUND'}
                    </span>
                    <h2>{r.title || r.origin}</h2>
                    {r.url && <p className="source-domain">{new URL(r.url).hostname}</p>}
                    {r.kind !== 'listing' && !!r.headingPath.length && (
                      <p className="crumb">{r.headingPath.join(' / ')}</p>
                    )}
                    {r.kind !== 'listing' && <blockquote>{r.quote}</blockquote>}
                    <div className="actions">
                      {r.local && (
                        <button className="primary" onClick={() => void show(r)}>
                          <Cursor size={15} />
                          Show on page
                        </button>
                      )}
                      {((r.kind === 'page' && !r.local) || r.kind === 'listing') &&
                        r.url &&
                        shareableUrl(r.url) &&
                        actionPolicy(r.url) === 'read_candidate' && (
                          <button
                            onClick={() =>
                              void openSource(
                                r.url!,
                                r.kind === 'listing' ? undefined : r.quote,
                              ).catch((e) => setError(e.message))
                            }
                          >
                            {r.kind === 'listing' ? 'Open listing' : 'Open source'}
                            <ArrowUpRight size={15} />
                          </button>
                        )}
                    </div>
                  </article>
                ))}
                <div
                  className="search-status"
                  role={state.lifecycle === 'running' ? 'status' : undefined}
                >
                  <p className={`reply ${state.lifecycle === 'failed' ? 'error' : ''}`}>
                    {summary(state)}
                  </p>
                  {state.lifecycle === 'running' && (
                    <div className="loading" aria-label="Searching">
                      <span />
                      <span />
                      <span />
                    </div>
                  )}
                </div>
                <>
                  {!!state.coverage.checkedPages?.length && (
                    <details className="page-details">
                      <summary>Search details</summary>
                      <p>
                        {state.coverage.candidatesAssessed ?? 0} of{' '}
                        {state.coverage.candidatesObserved ?? 0} candidates reviewed ·{' '}
                        {state.coverage.fetchAttempts ?? 0} page fetches ·{' '}
                        {state.coverage.urlsDiscovered} crawl destinations
                      </p>
                      {state.coverage.limitations.some((x) =>
                        ['more_local_candidates', 'more_candidates', 'snapshot_truncated'].includes(
                          x,
                        ),
                      ) && <p>Some page content remains unchecked.</p>}
                      {state.coverage.checkedPages.map((page, index) => (
                        <p key={index}>
                          {page.title || page.url || 'Current page'} —{' '}
                          {page.outcome.replaceAll('_', ' ')}
                          {page.url && (
                            <small style={{ display: 'block', overflowWrap: 'anywhere' }}>
                              {page.url}
                            </small>
                          )}
                        </p>
                      ))}
                    </details>
                  )}
                </>
              </>
            )}
            {/extension context invalidated/i.test(error) && (
              <button className="primary" onClick={reconnect}>
                Reconnect Cmd-F
              </button>
            )}
            {error && (
              <p className="reply error" role="alert">
                {/extension context invalidated/i.test(error)
                  ? 'Cmd-F disconnected after an extension reload. Reconnect to retry your prompt.'
                  : error}
              </p>
            )}
          </>
        )}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <span className="mark" title="Cmd-F">
          <Command size={20} weight="bold" />
        </span>
        <textarea
          ref={input}
          id="request"
          aria-label="Your request"
          rows={1}
          maxLength={500}
          placeholder="Ask this site…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={unavailable}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {running ? (
          <button
            type="button"
            aria-label="Stop search"
            disabled={busy}
            onClick={() => void stop()}
          >
            <Stop size={17} />
          </button>
        ) : (
          <button
            className="send"
            aria-label="Send request"
            disabled={!connected || question.trim().length < 2 || unavailable}
          >
            <ArrowUp size={18} />
          </button>
        )}
        <button
          type="button"
          aria-label="Connection settings"
          onClick={() => setSettings(!settings)}
        >
          <GearSix size={16} />
        </button>
        <button type="button" aria-label="Close Cmd-F" onClick={() => void close()}>
          <X size={16} />
        </button>
      </form>
    </section>
  );
}
function summary(state: SearchState) {
  if (state.lifecycle === 'failed') return state.message || 'The search failed. Please try again.';
  if (state.lifecycle === 'cancelled') return 'Search stopped. You can try another request.';
  if (state.lifecycle === 'waiting_for_user') return 'Reading a relevant section…';
  if (state.lifecycle === 'running')
    return state.message || 'Looking through this page and its sources…';
  const results = state.results.filter(
    (r) =>
      (r.evidence === 'direct' && r.provider !== 'lexical_fallback') ||
      (r.kind === 'listing' && r.evidence === 'candidate_only'),
  );
  if (state.coverage.stopReason.endsWith('reached')) return state.message;
  if (results.length && results.every((r) => r.kind === 'listing'))
    return 'Matching listings found. Destination details have not been verified.';
  if (!results.length) {
    if (state.coverage.stopReason === 'deadline_reached')
      return 'Search time limit reached before a source was verified.';
    if (state.coverage.stopReason === 'fetch_budget_reached')
      return `Search fetch limit reached. ${state.message}`;
    if (state.coverage.stopReason === 'page_budget_reached')
      return `Search page limit reached. ${state.message}`;
    return state.message || 'No relevant source found in the pages checked.';
  }
  return results.some((r) => r.kind === 'page' && !r.local && r.url)
    ? 'I found a page covering your request.'
    : 'I found the source on this page.';
}
function LaunchHelp() {
  const reason = new URLSearchParams(location.search).get('unavailable');
  const [shortcut, setShortcut] = useState('');
  useEffect(() => {
    if (isExtension)
      void chrome.commands
        .getAll()
        .then((commands) =>
          setShortcut(
            commands.find((c) => c.name === '_execute_action')?.shortcut || 'Not assigned',
          ),
        );
  }, []);
  const message =
    reason === 'restricted' || reason === '1'
      ? 'This tab is protected by the browser. Cmd-F can open on regular websites, but not New Tab, browser settings, extension pages, the Chrome Web Store, or built-in document viewers.'
      : reason === 'permission'
        ? 'The browser did not grant access to that tab. Return to the website, refresh it, and click the Cmd-F toolbar icon again. Check the extension’s site-access setting if access is still denied.'
        : 'Cmd-F could not load its page overlay. Reload the unpacked extension in your browser’s extensions page, refresh the website, and try again. This does not necessarily mean the website is restricted.';
  return (
    <main className="launch-help">
      <div className="brand">
        <Command size={22} />
        Cmd-F
      </div>
      <h1>Couldn’t open on that tab.</h1>
      <p>{message}</p>
      <h2>Set a shortcut that’s free</h2>
      <p>
        Use <strong>Option + Shift + F</strong> on Mac, or <strong>Alt + Shift + F</strong>{' '}
        elsewhere. An existing installation may still have the old shortcut.
      </p>
      {shortcut && (
        <p className="assigned">
          Currently assigned: <strong>{shortcut}</strong>
        </p>
      )}
      <button
        className="primary"
        onClick={() => {
          if (isExtension) void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
        }}
      >
        Configure keyboard shortcut <ArrowUpRight size={16} />
      </button>
      <p className="hint">
        In the shortcuts page, find Cmd-F → Activate the extension. Then return to the website you
        want to search.
      </p>
      <button onClick={() => window.close()}>Close this help page</button>
    </main>
  );
}
function App() {
  if (new URLSearchParams(location.search).has('unavailable')) return <LaunchHelp />;
  return isExtension ? (
    <Chat />
  ) : (
    <main className="demo">
      <iframe id="fixture" title="Owned fixture website" src="/fixtures/docs" />
      <div className="demo-chat">
        <Chat />
      </div>
      <a className="back" href="/sidepanel.html">
        Cmd-F playground
      </a>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);

import React, { useEffect, useRef, useState } from 'react';
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
import { pageHoldsFocus } from './focus';
import { jumpFor, readJumpPref, saveJumpPref, shouldFollow } from './jump';
import { alignReply } from './scroll';

export function Chat() {
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
  const [jump, setJump] = useState(false);
  const [follow, setFollow] = useState<'show' | 'open' | ''>('');
  const api = useRef(new Api(import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:4317', ''));
  const src = useRef(0);
  const followed = useRef<string | undefined>(undefined);
  const userTookOver = useRef(false);
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
  const reply = useRef<HTMLDivElement>(null);
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
    if (!root || !isExtension || location.protocol !== 'chrome-extension:') return;
    const observer = new ResizeObserver(() => {
      void chrome.runtime
        .sendMessage({
          type: 'RESIZE_OVERLAY',
          height: Math.ceil(root.getBoundingClientRect().height),
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
      setProvider(cfg.provider === 'mock' ? 'Demo keyword provider' : 'TypeSafe/Jev');
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
    input.current?.focus();
    void (async () => {
      try {
        setJump(await readJumpPref());
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
        if (!pageHoldsFocus(document.activeElement, measure.current)) input.current?.focus();
      } catch {
        setError('Could not connect to this page. Reopen Cmd-F with the shortcut.');
      }
    })();
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || pageHoldsFocus(document.activeElement, measure.current)) return;
      e.preventDefault();
      e.stopPropagation();
      void close();
    };
    window.addEventListener('keydown', escape, true);
    window.addEventListener('pagehide', cleanup);
    return () => {
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('pagehide', cleanup);
      cleanup();
    };
  }, []);
  useEffect(() => {
    const scroller = log.current;
    const latest = reply.current;
    if (!scroller || !latest || scroller.hidden) return;
    alignReply(scroller, latest);
  }, [asked, error, history.length, state?.id, state?.lifecycle, sources.length]);
  useEffect(() => {
    if (!state?.id) return;
    if (state.lifecycle !== 'completed') return;
    if (followed.current === state.id) return;
    followed.current = state.id;
    if (
      !shouldFollow({
        enabled: jump,
        lifecycle: state.lifecycle,
        searchId: state.id,
        followedId: undefined,
        userTookOver: userTookOver.current,
      })
    )
      return;
    const action = jumpFor(sources[0]);
    if (!action) return;
    if (action.kind === 'show') {
      setFollow('show');
      void show(action.result, 'auto');
      return;
    }
    setFollow('open');
    const timer = window.setTimeout(() => {
      void openSource(action.url, action.quote).catch((e) => setError((e as Error).message));
    }, 320);
    return () => window.clearTimeout(timer);
  }, [jump, state?.id, state?.lifecycle, sources[0]?.id]);
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
    if (location.protocol.startsWith('chrome-extension')) location.reload();
    else window.dispatchEvent(new Event('cmd-f-reconnect'));
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
      followed.current = undefined;
      userTookOver.current = false;
      setFollow('');
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
  async function show(result: EvidenceResult, origin: 'user' | 'auto' = 'user') {
    if (origin === 'user') userTookOver.current = true;
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
                <div className="preference">
                  <div className="preference-body">
                    <label id="jump-label">Jump to the answer</label>
                    <p>
                      When a search finishes, this page glides to the source — or a new tab opens.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="switch"
                    role="switch"
                    aria-checked={jump}
                    aria-labelledby="jump-label"
                    onClick={() => {
                      const next = !jump;
                      setJump(next);
                      void saveJumpPref(next);
                    }}
                  >
                    <span className="knob" />
                  </button>
                </div>
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
            {(asked || busy || state || error) && (
              <div className="latest-reply" ref={reply}>
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
                    {sources.map((r, i) => (
                      <article
                        className={`source ${r.kind === 'listing' ? 'listing' : 'passage'}${follow && i === 0 ? ' follow' : ''}`}
                        key={r.id}
                      >
                        <span className="eyebrow">
                          {r.kind === 'listing'
                            ? 'MATCHING LISTING'
                            : r.provider === 'mock'
                              ? 'DEMO MATCH'
                              : 'SOURCE FOUND'}
                        </span>
                        {follow && i === 0 && (
                          <p className="follow-note" role="status">
                            {follow === 'open' ? 'Opening in a new tab' : 'Gliding to this passage'}
                          </p>
                        )}
                        <h2>{r.title || r.origin}</h2>
                        {r.url && <p className="source-domain">{new URL(r.url).hostname}</p>}
                        {r.kind !== 'listing' && !!r.headingPath.length && (
                          <p className="crumb">{r.headingPath.join(' / ')}</p>
                        )}
                        {r.kind !== 'listing' && <blockquote>{r.quote}</blockquote>}
                        <div className="actions">
                          {r.local && (
                            <button
                              className="primary"
                              onClick={() => {
                                userTookOver.current = true;
                                void show(r);
                              }}
                            >
                              <Cursor size={15} />
                              Show on page
                            </button>
                          )}
                          {((r.kind === 'page' && !r.local) || r.kind === 'listing') &&
                            r.url &&
                            shareableUrl(r.url) &&
                            actionPolicy(r.url) === 'read_candidate' && (
                              <button
                                onClick={() => {
                                  userTookOver.current = true;
                                  void openSource(
                                    r.url!,
                                    r.kind === 'listing' ? undefined : r.quote,
                                  ).catch((e) => setError(e.message));
                                }}
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
                            [
                              'more_local_candidates',
                              'more_candidates',
                              'snapshot_truncated',
                            ].includes(x),
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
              </div>
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
  const note =
    reason === 'restricted' || reason === '1'
      ? 'This tab is protected by the browser. New Tab, browser settings, extension pages, the Chrome Web Store, and built-in document viewers stay off-limits. Regular websites work.'
      : reason === 'permission'
        ? 'The browser did not grant access to this tab. Return to the website, refresh it, and click the Cmd-F toolbar icon again. Check the extension’s site-access setting if access is still denied.'
        : 'Cmd-F could not load its page overlay here. Reload the unpacked extension in your browser’s extensions page, refresh the website, and try again. This does not necessarily mean the website is restricted.';
  return (
    <main className="launch-help">
      <div className="brand">
        <Command size={20} />
        Cmd-F
      </div>
      <h1>Start Cmd-F on any website</h1>
      <p className="lead">
        Cmd-F reads the page you are on and shows you where the answer is. It does not run on this
        tab, so start from a regular website.
      </p>
      <ol className="steps">
        <li>
          <div>
            <h2>Open a website</h2>
            <p>
              An article, documentation, a dashboard — anything outside the browser’s own pages.
            </p>
          </div>
        </li>
        <li>
          <div>
            <h2>Press the shortcut</h2>
            <p>
              <strong>Option + Shift + F</strong> on Mac, <strong>Alt + Shift + F</strong>{' '}
              elsewhere. Clicking the Cmd-F toolbar icon does the same thing.
            </p>
            {shortcut && (
              <p className="assigned">
                Currently assigned: <strong>{shortcut}</strong>
              </p>
            )}
          </div>
        </li>
        <li>
          <div>
            <h2>Ask for what you want</h2>
            <p>Cmd-F searches the page and highlights the exact text it used.</p>
          </div>
        </li>
      </ol>
      <div className="launch-actions">
        <button
          className="primary"
          onClick={() => {
            if (isExtension) void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
          }}
        >
          Configure keyboard shortcut <ArrowUpRight size={16} />
        </button>
        <button onClick={() => window.close()}>Close</button>
      </div>
      <section className="launch-note">
        <h2>Why not this tab?</h2>
        <p>{note}</p>
      </section>
    </main>
  );
}
export function App() {
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

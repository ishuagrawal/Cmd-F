import React, { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { createRoot } from 'react-dom/client';
import {
  MagnifyingGlass,
  ArrowUp,
  ArrowUpRight,
  ArrowRight,
  Command,
  SlidersHorizontal,
  Check,
  Copy,
  Cursor,
  GlobeSimple,
  FileText,
  X,
  Stop,
  LockSimple,
  CaretDown,
  ArrowClockwise,
  BookOpen,
  Sparkle,
} from '@phosphor-icons/react';
import {
  PROTOCOL,
  SnapshotSchema,
  StateSchema,
  type PageSnapshot,
  type SearchState,
  type EvidenceResult,
} from '../../../../packages/contracts/src';
import { actionPolicy, shareableUrl } from '../../../../packages/security/src';
import { isExtension, source, inspect, local, openSource } from './bridge';
import { Api } from './api';
import './style.css';
const emptySource: { tabId: number; url?: string; title?: string } = {
  tabId: 0,
  url: undefined as string | undefined,
  title: undefined as string | undefined,
};
function Panel() {
  const [src, setSrc] = useState(emptySource);
  const [question, setQuestion] = useState('');
  const [scope, setScope] = useState<'page' | 'site'>('site');
  const [snapshot, setSnapshot] = useState<PageSnapshot>();
  const [state, setState] = useState<SearchState>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);
  const [token, setToken] = useState('');
  const [apiBase, setApiBase] = useState(
    import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:4317',
  );
  const [mode, setMode] = useState('');
  const [providerTransport, setProviderTransport] = useState<'gateway' | 'typesafe'>();
  const [consentOpen, setConsentOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [siteConsent, setSiteConsent] = useState(false);
  const [copied, setCopied] = useState('');
  const [highlighted, setHighlighted] = useState(false);
  const api = useRef(new Api(apiBase, token));
  const stateRef = useRef<SearchState | undefined>(undefined);
  const snapshotRef = useRef<PageSnapshot | undefined>(undefined);
  const srcRef = useRef(src);
  const stream = useRef<AbortController | undefined>(undefined);
  const reading = useRef(false);
  const running = busy || state?.lifecycle === 'running';
  const waiting = state?.lifecycle === 'waiting_for_user';
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    srcRef.current = src;
  }, [src]);
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  async function connect(t: string, base = apiBase) {
    api.current = new Api(base, t);
    try {
      const cfg = z
        .object({
          provider: z.enum(['mock', 'jev']),
          transport: z.enum(['gateway', 'typesafe']).optional(),
          renderer: z.boolean(),
        })
        .parse(await api.current.call('/v1/config'));
      setMode(cfg.provider);
      setProviderTransport(cfg.transport);
    } catch {
      setMode('offline');
    }
  }
  async function refreshSource() {
    try {
      setSrc(await source());
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    async function init() {
      if (isExtension) {
        const values = await chrome.storage.local.get(['clientToken']);
        if (typeof values.clientToken === 'string') {
          setToken(values.clientToken);
          void connect(values.clientToken);
        } else setSettings(true);
        await refreshSource();
        const saved = await chrome.storage.session.get('searchId');
        if (typeof saved.searchId === 'string' && typeof values.clientToken === 'string') {
          try {
            const recovered = StateSchema.parse(
              await api.current.call(`/v1/searches/${saved.searchId}`),
            );
            setState(recovered);
            if (['running', 'waiting_for_user'].includes(recovered.lifecycle)) watch(recovered.id);
          } catch {
            await chrome.storage.session.remove('searchId');
          }
        }
      } else {
        try {
          const cfg = await fetch('/__dev/config').then((r) => r.json());
          setToken(cfg.token);
          setApiBase(cfg.api);
          await connect(cfg.token, cfg.api);
        } catch {
          setSettings(true);
        }
        await refreshSource();
      }
    }
    void init();
    const frame = document.querySelector<HTMLIFrameElement>('#fixture');
    const onLoad = () => {
      void api.current.close(stateRef.current?.id || '');
      stream.current?.abort();
      setState(undefined);
      setSnapshot(undefined);
      setHighlighted(false);
      void refreshSource();
    };
    frame?.addEventListener('load', onLoad);
    const closing = () => {
      if (stateRef.current) void api.current.close(stateRef.current.id);
      void local(srcRef.current.tabId, { type: 'STOP' }).catch(() => {});
    };
    window.addEventListener('pagehide', closing);
    const nav = (tabId: number, info: { status?: string; url?: string }) => {
      if (tabId === srcRef.current.tabId && (info.status === 'loading' || info.url)) {
        closing();
        stream.current?.abort();
        setState(undefined);
        setSnapshot(undefined);
        setError('The source page changed. Inspect it again to start a new search.');
      }
    };
    if (isExtension) chrome.tabs.onUpdated.addListener(nav);
    return () => {
      stream.current?.abort();
      closing();
      frame?.removeEventListener('load', onLoad);
      window.removeEventListener('pagehide', closing);
      if (isExtension) chrome.tabs.onUpdated.removeListener(nav);
    };
  }, []);
  useEffect(() => {
    if (!state?.id) return;
    const id = state.id;
    const lease = setInterval(() => {
      void api.current.call(`/v1/searches/${id}/lease`, 'POST').catch(() => {});
    }, 15000);
    return () => clearInterval(lease);
  }, [state?.id]);
  async function receive(next: SearchState) {
    setState(next);
    if (next.lifecycle !== 'running' && next.lifecycle !== 'waiting_for_user')
      void local(srcRef.current.tabId, { type: 'STOP' }).catch(() => {});
    if (next.requestedSections.length && !reading.current) {
      const s = snapshotRef.current;
      if (!s || next.requestedSections.some((id) => !s.sectionIds.includes(id))) {
        setError('The requested section is not in the approved page snapshot.');
        return;
      }
      reading.current = true;
      try {
        const fresh = SnapshotSchema.parse(
          await local(srcRef.current.tabId, {
            type: 'READ_SECTION',
            snapshotId: s.id,
            sectionIds: next.requestedSections,
          }),
        );
        snapshotRef.current = fresh;
        setSnapshot(fresh);
        await api.current.resume(next.id, fresh);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        reading.current = false;
      }
    }
  }
  function watch(id: string) {
    stream.current?.abort();
    const ctrl = new AbortController();
    stream.current = ctrl;
    void api.current
      .events(id, ctrl.signal, (next) => void receive(next))
      .catch((e) => {
        if (!ctrl.signal.aborted) setError((e as Error).message);
      });
  }
  async function prepare() {
    if (!question.trim() || running) return;
    setError('');
    setBusy(true);
    try {
      if (stateRef.current) await api.current.close(stateRef.current.id);
      stream.current?.abort();
      setState(undefined);
      const current = await source();
      setSrc(current);
      const snap = await inspect(current.tabId, question);
      snapshotRef.current = snap;
      setSnapshot(snap);
      setConsent(false);
      setSiteConsent(false);
      setConsentOpen(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    if (!snapshot || !consent || (scope === 'site' && !siteConsent)) return;
    setBusy(true);
    setError('');
    try {
      const next = await api.current.create({
        protocol: PROTOCOL,
        question,
        scope,
        snapshot,
        consent: true,
        publicSearchConsent: siteConsent,
        refresh: false,
      });
      setConsentOpen(false);
      setState(next);
      stateRef.current = next;
      if (isExtension)
        await chrome.storage.session.set({ searchId: next.id, sourceTabId: src.tabId });
      watch(next.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    if (!state) return;
    try {
      const next = StateSchema.parse(
        await api.current.call(`/v1/searches/${state.id}/cancel`, 'POST'),
      );
      setState(next);
      stream.current?.abort();
      await local(src.tabId, { type: 'STOP' });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function show(r: EvidenceResult) {
    setError('');
    try {
      await local(src.tabId, {
        type: 'SHOW',
        snapshotId: r.snapshotId,
        candidateId: r.candidate.id,
        documentId: r.documentId,
      });
      setHighlighted(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function clearData() {
    if (state) await api.current.close(state.id);
    stream.current?.abort();
    await local(src.tabId, { type: 'CLEAR' }).catch(() => {});
    await local(src.tabId, { type: 'STOP' }).catch(() => {});
    setState(undefined);
    setSnapshot(undefined);
    setQuestion('');
    setHighlighted(false);
    setConsent(false);
    setConsentOpen(false);
    if (isExtension) await chrome.storage.session.remove(['searchId']);
  }
  const host = src.url ? new URL(src.url).hostname : 'Current website';
  return (
    <div className="panel">
      <header className="brandbar flex items-center justify-between">
        <a className="brand" href="#" onClick={(e) => e.preventDefault()} aria-label="Cmd-F home">
          <span className="brandmark">
            <Command size={18} />
          </span>
          Cmd-F<span className="beta">PREVIEW</span>
        </a>
        <button
          className="iconbutton"
          aria-label="Connection settings"
          onClick={() => setSettings(!settings)}
        >
          <SlidersHorizontal size={19} />
        </button>
      </header>
      <div className="panel-content">
        <div className="site-line">
          <span className="site-icon">
            <GlobeSimple size={14} />
          </span>
          <span>{host}</span>
          <span
            className="connection-dot"
            data-offline={mode === 'offline'}
            title={mode === 'offline' ? 'API offline' : 'Connected'}
          />
        </div>
        <section className="intro">
          <div className="eyebrow">A SHORTCUT TO THE SOURCE</div>
          <h1>Find what you mean.</h1>
          <p>
            A passage, a page, the right button.
            <br />
            Ask naturally. We’ll find where it lives.
          </p>
        </section>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void prepare();
          }}
          className="query-form"
        >
          <label htmlFor="question">What are you looking for?</label>
          <div className="query-box">
            <textarea
              id="question"
              value={question}
              maxLength={500}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="How do loops work in Python?"
              rows={3}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void prepare();
                }
              }}
            />
            <div className="query-bottom">
              <span>Find it in your own words</span>
              <button
                className="send"
                type="submit"
                disabled={!question.trim() || running}
                aria-label="Find source"
              >
                <ArrowUp size={19} weight="bold" />
              </button>
            </div>
          </div>
          <div className="scope-row">
            <div className="scope" role="group" aria-label="Search scope">
              <button
                type="button"
                aria-pressed={scope === 'page'}
                onClick={() => setScope('page')}
              >
                <FileText size={13} />
                This page
              </button>
              <button
                type="button"
                aria-pressed={scope === 'site'}
                onClick={() => setScope('site')}
              >
                <GlobeSimple size={13} />
                This site
              </button>
            </div>
            <span>Starts here. Looks further.</span>
          </div>
        </form>
        {mode === 'mock' && (
          <div className="mode-note">
            <span className="tiny-square" />
            Demo provider · deterministic keyword matching
          </div>
        )}
        {mode === 'offline' && (
          <div className="error" role="alert">
            The local API is offline. Start it with <code>pnpm dev</code>, then reconnect in
            settings.
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={14} />
            </button>
          </div>
        )}
        {state?.lifecycle === 'failed' && (
          <div className="error" role="status">
            {state.message || 'AI verification could not finish. Try again.'}
          </div>
        )}
        {settings && (
          <section className="settings surface">
            <div className="section-label">
              CONNECTION{' '}
              <button
                className="iconbutton"
                aria-label="Close settings"
                onClick={() => setSettings(false)}
              >
                <X size={16} />
              </button>
            </div>
            <p>The local backend keeps your provider key out of the browser.</p>
            <label htmlFor="token">Local client token</label>
            <input
              id="token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="From .local/client-token"
              autoComplete="off"
            />
            <button
              className="primary"
              onClick={async () => {
                if (isExtension) await chrome.storage.local.set({ clientToken: token });
                await connect(token);
                setSettings(false);
              }}
            >
              Connect <ArrowRight size={15} />
            </button>
            <button className="textbutton" onClick={() => void clearData()}>
              Revoke this search & clear its data
            </button>
          </section>
        )}
        {running && (
          <section className="progress" aria-live="polite">
            <div className="progress-title">
              <span className="pulse-dot" />
              {state?.message || 'Inspecting this page'}
              <button aria-label="Stop search" className="iconbutton" onClick={() => void stop()}>
                <Stop size={15} />
              </button>
            </div>
            <div className="skeleton w-full" />
            <div className="skeleton w-4/5" />
            <div className="skeleton w-3/5" />
            {state && (
              <small>
                {state.coverage.pagesChecked} pages checked · {state.coverage.urlsDiscovered} links
                discovered
              </small>
            )}
          </section>
        )}
        {state?.results.length ? (
          <section className="results" aria-live="polite">
            <div className="section-label">
              AT THE SOURCE
              <span>{state.results.length.toString().padStart(2, '0')}</span>
            </div>
            {state.results
              .filter((r) => r.evidence === 'direct' && r.provider !== 'lexical_fallback')
              .map((r, i) => (
                <article key={r.id} className="result">
                  <div className="result-meta">
                    <span>
                      {r.kind === 'control' ? <Cursor size={13} /> : <FileText size={13} />}{' '}
                      {r.kind}
                    </span>
                    <span>
                      {r.provider === 'mock'
                        ? 'Demo match'
                        : r.evidence === 'direct'
                          ? 'Direct evidence'
                          : r.evidence.replaceAll('_', ' ')}
                    </span>
                  </div>
                  <h2>{r.title || r.origin}</h2>
                  {r.headingPath.length > 0 && (
                    <div className="breadcrumb">{r.headingPath.join(' / ')}</div>
                  )}
                  <blockquote>{r.quote}</blockquote>
                  <div className="source-path">
                    {r.url
                      ? `${new URL(r.url).hostname}${new URL(r.url).pathname}`
                      : 'Private page · URL kept local'}
                  </div>
                  <div className="result-actions">
                    {r.local ? (
                      <button
                        className={i === 0 ? 'primary' : 'secondary'}
                        onClick={() => void show(r)}
                      >
                        <Cursor size={15} />
                        Show here
                      </button>
                    ) : r.url && shareableUrl(r.url) && actionPolicy(r.url) === 'read_candidate' ? (
                      <button
                        className={i === 0 ? 'primary' : 'secondary'}
                        onClick={() => void openSource(r.url!).catch((e) => setError(e.message))}
                      >
                        Open source
                        <ArrowUpRight size={15} />
                      </button>
                    ) : null}
                    <button
                      className="iconbutton"
                      aria-label="Copy quote"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(r.quote);
                          setCopied(r.id);
                          setTimeout(() => setCopied(''), 1800);
                        } catch {
                          setError(
                            'Clipboard access is unavailable. Select the excerpt to copy it.',
                          );
                        }
                      }}
                    >
                      {copied === r.id ? <Check size={16} /> : <Copy size={16} />}
                    </button>
                  </div>
                  <time dateTime={r.observedAt}>
                    Observed{' '}
                    {new Date(r.observedAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </article>
              ))}
          </section>
        ) : state && !running && !waiting ? (
          <div className="empty-result">
            <MagnifyingGlass size={25} />
            <h3>
              {state.lifecycle === 'cancelled'
                ? 'Search stopped.'
                : 'No answer found in the pages checked.'}
            </h3>
            <p>
              Try a different question or broaden the scope. The rest of the website may still have
              the answer.
            </p>
          </div>
        ) : null}
        {highlighted && (
          <button
            className="textbutton clear-highlight"
            onClick={() => {
              void local(src.tabId, { type: 'CLEAR' });
              setHighlighted(false);
            }}
          >
            <X size={13} />
            Clear highlight
          </button>
        )}
        {state && (
          <details className="coverage">
            <summary>
              Search coverage <CaretDown size={14} />
            </summary>
            <div className="coverage-grid">
              <div>
                <b>{state.coverage.pagesChecked}</b>
                <span>pages checked</span>
              </div>
              <div>
                <b>{state.coverage.urlsDiscovered}</b>
                <span>links discovered</span>
              </div>
              <div>
                <b>{state.coverage.blocked}</b>
                <span>links blocked</span>
              </div>
            </div>
            <p>
              {state.coverage.scope.replaceAll('_', ' ')} · {state.lifecycle.replaceAll('_', ' ')}
            </p>
            {state.coverage.limitations.map((l) => (
              <p key={l} className="limitation">
                {l.replaceAll('_', ' ')}
              </p>
            ))}
            <p>
              Bounded search. Results don’t establish completeness or guarantee that a source is
              correct.
            </p>
            <button className="textbutton" onClick={() => watch(state.id)}>
              Reconnect to search
            </button>
            <button className="textbutton" onClick={() => void clearData()}>
              Clear this search
            </button>
          </details>
        )}
        {!state && !running && !consentOpen && (
          <section className="suggestions">
            <div className="section-label">A FEW WAYS TO FIND YOUR WAY</div>
            {[
              ['How do loops work in Python?', 'Find an explanation'],
              ['What is the baby’s name?', 'Locate a detail'],
              ['Where can I cancel my membership?', 'Find a control'],
            ].map(([q, sub], i) => (
              <button key={q} onClick={() => setQuestion(q)}>
                <span className="suggestion-icon">
                  {i === 0 ? (
                    <BookOpen size={18} />
                  ) : i === 1 ? (
                    <MagnifyingGlass size={18} />
                  ) : (
                    <Cursor size={18} />
                  )}
                </span>
                <span>
                  <b>{q}</b>
                  <small>{sub}</small>
                </span>
                <ArrowUpRight size={15} />
              </button>
            ))}
            <div className="how-it-works">
              <div className="line-illustration">
                <span />
                <MagnifyingGlass size={29} />
                <span />
              </div>
              <p>
                The answer is already out there.
                <br />
                Let’s take you to it.
              </p>
            </div>
          </section>
        )}
      </div>
      <footer className="panel-footer">
        <LockSimple size={13} />
        <span>You choose what to share. You make the clicks.</span>
      </footer>
      {consentOpen && snapshot && (
        <div className="consent-backdrop">
          <section
            className="consent-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="consent-title"
          >
            <div className="section-label">
              <LockSimple size={15} /> BEFORE WE LOOK{' '}
              <button
                className="iconbutton"
                aria-label="Close consent"
                onClick={() => {
                  setConsentOpen(false);
                  void local(src.tabId, { type: 'STOP' });
                }}
              >
                <X size={17} />
              </button>
            </div>
            <h2 id="consent-title">Your page. Your permission.</h2>
            <p>
              Your question and the selected page text below will go to your configured backend
              {mode === 'jev'
                ? providerTransport === 'gateway'
                  ? ', Vercel AI Gateway, and TypeSafe/Jev'
                  : ' and TypeSafe/Jev'
                : ''}
              . This can include private page content. Redaction may miss personal information.
            </p>
            <details className="preview">
              <summary>
                Preview shared text <span>{snapshot.candidates.length} candidates</span>
              </summary>
              <p>{question}</p>
              <p>
                {snapshot.title} · {snapshot.url || snapshot.origin}
              </p>
              {snapshot.candidates.map((c) => (
                <pre key={c.id}>{c.text || c.label}</pre>
              ))}
            </details>
            <p className="small-note">
              Relevant sections may be read during this search. Passwords, form values, and drafts
              are excluded. Raw snapshots stay in session memory and are deleted when the search
              ends. Provider retention follows its own policy.
            </p>
            <label className="check-label">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>Share this page’s selected text for this search.</span>
            </label>
            {scope === 'site' && (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={siteConsent}
                  onChange={(e) => setSiteConsent(e.target.checked)}
                />
                <span>Also check public pages on this exact site anonymously.</span>
              </label>
            )}
            <button
              className="primary full"
              disabled={!consent || (scope === 'site' && !siteConsent) || busy}
              onClick={() => void start()}
            >
              Find the source <ArrowRight size={17} />
            </button>
            {error && <p className="error">{error}</p>}
          </section>
        </div>
      )}
    </div>
  );
}
function Playground() {
  const [fixture, setFixture] = useState('docs');
  return (
    <div className="playground">
      <div className="workspace-bar">
        <a className="workspace-brand" href="#">
          <Command size={18} />
          Cmd-F <span>THE PLAYGROUND</span>
        </a>
        <div className="fixture-tabs" role="group" aria-label="Fixture website">
          {[
            ['docs', 'Documentation'],
            ['news', 'A news article'],
            ['account', 'An account menu'],
          ].map(([value, label]) => (
            <button aria-pressed={fixture === value} onClick={() => setFixture(value)} key={value}>
              {label}
            </button>
          ))}
        </div>
        <span className="local-badge">
          <span />
          OWNED TEST PAGES
        </span>
      </div>
      <div className="workspace">
        <div className="browser">
          <div className="browser-toolbar">
            <div className="window-dots">
              <i />
              <i />
              <i />
            </div>
            <div className="address">
              <LockSimple size={12} />
              <span>fieldnotes.local / {fixture === 'docs' ? 'handbook' : fixture}</span>
            </div>
            <ArrowClockwise size={14} />
          </div>
          <iframe id="fixture" title="Owned fixture website" src={`/fixtures/${fixture}`} />
          <div className="browser-caption">
            <Sparkle size={13} />A real page, a real search. Nothing on the page is clicked for you.
          </div>
        </div>
        <aside className="panel-container">
          <Panel />
        </aside>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(isExtension ? <Panel /> : <Playground />);

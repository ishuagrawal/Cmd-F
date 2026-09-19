import { randomUUID } from 'node:crypto';
import {
  PROTOCOL,
  type PageSnapshot,
  type SearchRequest,
  type SearchState,
  type SearchEvent,
  type EvidenceResult,
  type Candidate,
} from '../../../../packages/contracts/src';
import { actionPolicy, shareableUrl, urlIdentity, redact } from '../../../../packages/security/src';
import { rank, rankRoutes, shortlist } from '../../../../packages/retrieval/src';
import {
  type Provider,
  type ProviderBudget,
  type Decision,
  providerFailureReason,
} from '../../../../packages/jev/src';
import { extractHtml } from '../../../../packages/extraction/src/html';
import { SafeFetcher } from '../fetch/safe-fetch';
import { PublicCache } from '../cache/public-cache';
import { loadRobots, discoverSitemaps } from '../fetch/discovery';
class VerificationError extends Error {
  constructor(readonly reason: ReturnType<typeof providerFailureReason>) {
    super(reason);
  }
}
const verificationMessages: Record<ReturnType<typeof providerFailureReason>, string> = {
  provider_rate_limited: 'TypeSafe rate-limited this search. Try again later.',
  provider_budget_exhausted:
    'This search reached its AI verification limit. Try a narrower request.',
  provider_timeout: 'AI verification timed out. Try again.',
  provider_invalid_response: 'Jev returned a response that could not be validated. Try again.',
  provider_auth_failed: 'The provider rejected the API credentials. Check the backend API key.',
  provider_payload_limit: 'This page exceeded the AI request size limit. Try a narrower request.',
  provider_unavailable:
    'AI verification could not finish because of a provider or connection error. Try again.',
};
export interface Limits {
  maxPages: number;
  maxUrls: number;
  deadlineMs: number;
  leaseMs: number;
  ttlMs: number;
}
export const defaultLimits: Limits = {
  maxPages: 5,
  maxUrls: 5000,
  deadlineMs: 30000,
  leaseMs: 45000,
  ttlMs: 600000,
};
export function sanitizeSnapshot(snapshot: PageSnapshot): PageSnapshot {
  const safe = shareableUrl(snapshot.url || '');
  return {
    ...snapshot,
    url: safe,
    title: redact(snapshot.title),
    candidates: snapshot.candidates.map((c) => {
      const url = c.safeUrl && shareableUrl(c.safeUrl);
      return {
        ...c,
        label: redact(c.label),
        text: c.text && redact(c.text),
        context: redact(c.context),
        headingPath: c.headingPath.map(redact),
        safeUrl: url,
        actionPolicy:
          c.kind === 'control'
            ? 'highlight_only'
            : c.kind === 'link'
              ? url
                ? actionPolicy(url)
                : 'highlight_only'
              : 'read_candidate',
      };
    }),
  };
}
export class SearchSession {
  readonly id = randomUUID();
  readonly born = Date.now();
  lease = Date.now();
  state: SearchState;
  events: SearchEvent[] = [];
  listeners = new Set<(event: SearchEvent) => void>();
  private request?: SearchRequest;
  private abort = new AbortController();
  private budget: ProviderBudget = { calls: 0, bytes: 0, inputTokens: 0, outputTokens: 0 };
  private activeTime = 0;
  private segmentStart = Date.now();
  private pendingDocument: string;
  private pendingOrigin: string;
  private publicAttempts = 0;
  private visitedPublic = new Set<string>();
  private discoveredPublic = new Set<string>();
  private sitemapBudget = { seen: new Set<string>(), bytes: 0 };
  constructor(
    readonly owner: string,
    request: SearchRequest,
    private provider: Provider,
    private fetcher: SafeFetcher,
    private cache: PublicCache,
    private limits: Limits = defaultLimits,
  ) {
    this.request = { ...request, snapshot: sanitizeSnapshot(request.snapshot) };
    this.pendingDocument = request.snapshot.documentId;
    this.pendingOrigin = request.snapshot.origin;
    this.state = {
      id: this.id,
      lifecycle: 'running',
      evidence: 'none',
      provider: provider.mode,
      results: [],
      message: 'Checking this page',
      requestedSections: [],
      revealSteps: 0,
      coverage: {
        pagesChecked: 0,
        urlsDiscovered: 0,
        blocked: 0,
        cacheHits: 0,
        providerCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        elapsedMs: 0,
        scope: 'current_page',
        limitations: [],
        stopReason: '',
        checkedPages: [],
      },
    };
  }
  emit(type: SearchEvent['type']) {
    this.state.coverage.elapsedMs = this.activeTime + Date.now() - this.segmentStart;
    this.state.coverage.providerCalls = this.budget.calls;
    this.state.coverage.validationFailures = this.budget.validationFailures;
    this.state.coverage.inputTokens = this.budget.inputTokens;
    this.state.coverage.outputTokens = this.budget.outputTokens;
    const event: SearchEvent = {
      protocol: PROTOCOL,
      id: (this.events.at(-1)?.id || 0) + 1,
      searchId: this.id,
      type,
      state: structuredClone(this.state),
    };
    this.events.push(event);
    if (this.events.length > 100) this.events.shift();
    this.listeners.forEach((l) => l(event));
  }
  private limitation(s: string) {
    if (!this.state.coverage.limitations.includes(s)) this.state.coverage.limitations.push(s);
  }
  private done(reason: string) {
    this.state.lifecycle = 'completed';
    this.state.coverage.stopReason = reason;
    this.state.message =
      this.state.evidence === 'direct'
        ? 'Source found'
        : this.state.results.length
          ? 'Possible sources found'
          : this.state.coverage.limitations.includes('provider_invalid_response')
            ? 'Some sources could not be verified because the AI returned invalid responses.'
            : this.state.coverage.limitations.some((x) =>
                  [
                    'blocked',
                    'fetch_failed',
                    'fetch_or_policy_blocked',
                    'public_search_unavailable',
                  ].includes(x),
                )
              ? 'No verified source found. Some pages could not be accessed.'
              : 'No answer found in the pages checked.';
    this.request = undefined;
    this.emit('completed');
  }
  cancel(reason = 'user_stopped') {
    if (['completed', 'failed', 'cancelled'].includes(this.state.lifecycle)) return;
    this.abort.abort();
    this.state.lifecycle = 'cancelled';
    this.state.message = 'Search stopped';
    this.state.coverage.stopReason = reason;
    this.request = undefined;
    this.emit('cancelled');
  }
  clear() {
    this.cancel('panel_closed');
    this.request = undefined;
    this.state.results = [];
    this.events = [];
    this.listeners.clear();
  }
  tick(now: number) {
    if (now - this.born > this.limits.ttlMs || now - this.lease > this.limits.leaseMs)
      this.cancel(now - this.born > this.limits.ttlMs ? 'session_expired' : 'lease_expired');
  }
  async resume(snapshot: PageSnapshot) {
    if (this.state.lifecycle !== 'waiting_for_user' || !this.request)
      throw new Error('not_waiting');
    if (snapshot.documentId !== this.pendingDocument || snapshot.origin !== this.pendingOrigin)
      throw new Error('stale_document');
    if (this.state.revealSteps >= 4) throw new Error('reveal_budget');
    this.state.revealSteps++;
    this.request.snapshot = sanitizeSnapshot(snapshot);
    this.state.requestedSections = [];
    this.state.lifecycle = 'running';
    this.state.results = [];
    this.state.evidence = 'none';
    this.abort = new AbortController();
    void this.run();
  }
  private async decide(
    question: string,
    candidates: Candidate[],
    signal: AbortSignal,
    purpose: 'route' | 'evidence' | 'destination' = 'evidence',
    inspectedPage?: PageSnapshot,
  ): Promise<Decision> {
    try {
      return await this.provider.select(question, candidates, signal, this.budget, purpose, {
        sourceTitle: this.request?.snapshot.title || '',
        sourceUrl: this.request?.snapshot.url,
        inspectedPage: inspectedPage && { title: inspectedPage.title, url: inspectedPage.url },
      });
    } catch (error) {
      signal.throwIfAborted();
      const reason = providerFailureReason(error);
      this.limitation(reason);
      if (reason === 'provider_invalid_response') return { support: 0, mode: this.provider.mode };
      throw new VerificationError(reason);
    }
  }
  private async inspect(snapshot: PageSnapshot, local: boolean, signal: AbortSignal) {
    const trace = {
      url: snapshot.url,
      title: snapshot.title,
      outcome: 'checking' as NonNullable<
        SearchState['coverage']['checkedPages']
      >[number]['outcome'],
    };
    this.state.coverage.checkedPages!.push(trace);
    let remaining = snapshot.candidates.filter(
      (c) =>
        (c.kind === 'passage' || (local && c.kind === 'control')) &&
        !c.disabled &&
        c.visibility !== 'hidden' &&
        !c.truncated &&
        c.textRole !== 'heading',
    );
    const failuresBefore = this.budget.validationFailures?.length || 0;
    // Two bounded candidate windows: reject a passage, not its entire page.
    // An abstention moves to unseen candidates rather than repeating the same call.
    for (let attempt = 0; remaining.length && attempt < 2; attempt++) {
      const batch = shortlist(this.request!.question, remaining, 24);
      const decision = await this.decide(
        this.request!.question,
        batch,
        signal,
        local ? 'evidence' : 'destination',
        snapshot,
      );
      const evidence = this.result(snapshot, decision, local);
      if (evidence) {
        trace.outcome = 'verified';
        this.add(evidence);
        return true;
      }
      const excluded = new Set(
        decision.candidate ? [decision.candidate.id] : batch.map((c) => c.id),
      );
      remaining = remaining.filter((c) => !excluded.has(c.id));
    }
    trace.outcome =
      (this.budget.validationFailures?.length || 0) > failuresBefore
        ? 'verification_failed'
        : 'no_evidence';
    return false;
  }
  private result(snapshot: PageSnapshot, d: Decision, local: boolean): EvidenceResult | undefined {
    const c = d.candidate;
    if (
      !c ||
      c.disabled ||
      c.visibility === 'hidden' ||
      !['passage', 'control', 'link'].includes(c.kind)
    )
      return;
    // Routing choices guide exploration, but only a separate successful
    // verification may become a visible source.
    if (
      d.mode === 'lexical_fallback' ||
      !(d.verified ?? d.support >= 0.85) ||
      c.kind === 'link' ||
      (!local && c.kind === 'control') ||
      c.truncated === true ||
      (c.truncated === undefined &&
        snapshot.limitations.includes('passage_truncated') &&
        (c.text?.length || 0) >= 9000)
    )
      return;
    const evidence = 'direct' as const;
    // No generated excerpts: text always comes from the selected immutable record.
    let sourceUrl = local ? undefined : snapshot.url;
    const currentUrl = this.request?.snapshot.url;
    if (
      sourceUrl &&
      currentUrl &&
      urlIdentity(sourceUrl).fetchKey === urlIdentity(currentUrl).fetchKey
    )
      sourceUrl = undefined;
    if (c.kind === 'passage' && sourceUrl && c.headingId) {
      const anchored = new URL(sourceUrl);
      if (!anchored.hash.startsWith('#/')) {
        anchored.hash = c.headingId;
        sourceUrl = anchored.href;
      }
    }
    return {
      id: `${snapshot.id}:${c.id}`,
      kind: !local ? 'page' : (c.kind as 'passage' | 'control'),
      title: snapshot.title,
      url: sourceUrl,
      origin: snapshot.origin,
      quote: c.text || c.label,
      headingPath: c.headingPath,
      observedAt: snapshot.observedAt,
      evidence,
      candidate: c,
      snapshotId: snapshot.id,
      documentId: snapshot.documentId,
      local,
      provider: d.mode,
      model: d.model,
    };
  }
  private add(result: EvidenceResult) {
    if (!this.state.results.some((r) => r.id === result.id)) this.state.results.push(result);
    const order = { direct: 3, partial: 2, candidate_only: 1, none: 0 };
    this.state.results.sort((a, b) => order[b.evidence] - order[a.evidence]);
    this.state.results = this.state.results.slice(0, 3);
    this.state.evidence = this.state.results[0]?.evidence || 'none';
    this.emit('result_updated');
  }
  async run() {
    const request = this.request;
    if (!request) return;
    const start = Date.now();
    this.segmentStart = start;
    const timer = setTimeout(
      () => this.abort.abort(new Error('deadline')),
      Math.max(1, this.limits.deadlineMs - this.activeTime),
    );
    const signal = this.abort.signal;
    try {
      this.emit('started');
      const current = request.snapshot;
      current.limitations.forEach((x) => this.limitation(x));
      if (this.state.coverage.pagesChecked === 0) this.state.coverage.pagesChecked++;
      await this.inspect(current, true, signal);
      this.emit('snapshot_checked');
      if (this.state.evidence === 'direct') {
        this.done('direct_evidence');
        return;
      }
      const groups = current.candidates.filter((c) => c.kind === 'group');
      const promisingLink = rank(
        request.question,
        current.candidates.filter((c) => c.kind === 'link' && c.safeUrl),
      )[0];
      if (
        groups.length &&
        this.state.revealSteps < 4 &&
        !(request.scope === 'site' && promisingLink?.score > 0)
      ) {
        const g = await this.decide(request.question, groups, signal, 'route');
        if (g.candidate?.sectionId && current.sectionIds.includes(g.candidate.sectionId)) {
          this.state.lifecycle = 'waiting_for_user';
          this.state.requestedSections = [g.candidate.sectionId];
          this.state.message = 'Reading a relevant section';
          this.emit('needs_local_content');
          return;
        }
      }
      if (
        request.scope === 'site' &&
        current.url &&
        actionPolicy(current.url) === 'read_candidate'
      ) {
        this.state.message = 'Checking related pages';
        this.state.coverage.scope = 'bounded_site_search';
        const frontier = new Map<string, Candidate>();
        const visited = this.visitedPublic;
        visited.add(urlIdentity(current.url).fetchKey);
        const seenContent = new Set<string>();

        const enqueue = (c: Candidate) => {
          if (!c.safeUrl) return;
          const safe = shareableUrl(c.safeUrl);
          if (
            !safe ||
            new URL(safe).origin !== current.origin ||
            actionPolicy(safe) !== 'read_candidate'
          ) {
            this.state.coverage.blocked++;
            return;
          }
          const { fetchKey, routeKey } = urlIdentity(safe);
          if (routeKey.includes('#/') || routeKey.includes('#!')) {
            this.limitation('rendering_needed');
            return;
          }
          if (visited.has(fetchKey) || frontier.has(fetchKey)) return;
          if (this.discoveredPublic.size >= this.limits.maxUrls) {
            this.limitation('url_budget_reached');
            return;
          }
          frontier.set(fetchKey, c);
          this.discoveredPublic.add(fetchKey);
          this.state.coverage.urlsDiscovered = this.discoveredPublic.size;
        };
        current.candidates.filter((c) => c.kind === 'link').forEach(enqueue);
        this.emit('page_discovered');
        try {
          const robots = await loadRobots(this.fetcher, current.origin, signal);
          let mapsLoaded = false;
          const expandSitemaps = async () => {
            mapsLoaded = true;
            const sitemapUrls = await discoverSitemaps(
              this.fetcher,
              current.origin,
              robots.sitemaps,
              robots.allows,
              signal,
              this.sitemapBudget,
            );
            sitemapUrls.forEach((url, i) =>
              enqueue({
                id: `map${i}`,
                snapshotId: current.id,
                kind: 'link',
                label: new URL(url, current.origin).pathname,
                safeUrl: url,
                headingPath: [],
                context: 'Sitemap',
                visibility: 'unknown',
                actionPolicy: 'read_candidate',
                provenance: 'sitemap',
                contentHash: '',
              }),
            );
          };
          let lastStart = 0;
          while (this.publicAttempts < this.limits.maxPages) {
            if (!frontier.size && !mapsLoaded) await expandSitemaps();
            if (!frontier.size) break;
            signal.throwIfAborted();
            let ordered = rankRoutes(request.question, [...frontier.values()], current);
            if (!mapsLoaded && !(ordered[0]?.score > 0)) {
              await expandSitemaps();
              ordered = rankRoutes(request.question, [...frontier.values()], current);
            }
            const choice = await this.decide(
              request.question,
              ordered.slice(0, 24).map((x) => x.candidate),
              signal,
              'route',
            );
            const candidate = choice.candidate || ordered[0]?.candidate;
            if (!candidate) break;
            const key = urlIdentity(candidate.safeUrl!).fetchKey;
            frontier.delete(key);
            visited.add(key);
            if (!robots.allows(key)) {
              this.state.coverage.blocked++;
              this.limitation('robots_disallowed');
              continue;
            }
            const gap = robots.delay - (Date.now() - lastStart);
            if (gap > 0)
              await new Promise<void>((resolve, reject) => {
                const t = setTimeout(resolve, gap);
                signal.addEventListener(
                  'abort',
                  () => {
                    clearTimeout(t);
                    reject(new Error('cancelled'));
                  },
                  { once: true },
                );
              });
            signal.throwIfAborted();
            lastStart = Date.now();
            this.publicAttempts++;
            try {
              let artifact = request.refresh ? undefined : this.cache.get(key);
              if (artifact) this.state.coverage.cacheHits++;
              else
                artifact = await this.fetcher.get(
                  key,
                  current.origin,
                  signal,
                  2_000_000,
                  robots.allows,
                );
              if (artifact.status === 429) {
                this.limitation('rate_limited');
                break;
              }
              if (artifact.status === 401 || artifact.status === 403) {
                this.limitation('blocked');
                this.state.coverage.checkedPages!.push({
                  url: key,
                  title: candidate.label,
                  outcome: 'blocked',
                });
                continue;
              }
              if (artifact.status !== 200) {
                this.state.coverage.checkedPages!.push({
                  url: key,
                  title: candidate.label,
                  outcome: 'fetch_failed',
                });
                this.limitation('fetch_failed');
                continue;
              }
              if (
                !/text\/html|application\/xhtml\+xml/i.test(artifact.headers['content-type'] || '')
              ) {
                this.state.coverage.checkedPages!.push({
                  url: key,
                  title: candidate.label,
                  outcome: 'unsupported',
                });
                this.limitation('media_unsupported');
                continue;
              }
              const snapshot = extractHtml(artifact.body, artifact.url, request.question);
              snapshot.observedAt = artifact.retrievedAt;
              this.state.coverage.pagesChecked++;
              this.emit('page_checked');
              if (snapshot.limitations.includes('login_required')) {
                this.limitation('login_required');
                continue;
              }
              if (
                /checking your browser|verify you are human|access denied/i.test(snapshot.title)
              ) {
                this.limitation('blocked');
                this.state.coverage.checkedPages!.push({
                  url: key,
                  title: candidate.label,
                  outcome: 'blocked',
                });
                continue;
              }
              this.cache.put(artifact);
              snapshot.limitations.forEach((x) => this.limitation(x));
              const fingerprint = snapshot.candidates.map((x) => x.contentHash).join('-');
              if (seenContent.has(fingerprint)) continue;
              seenContent.add(fingerprint);
              snapshot.candidates.filter((c) => c.kind === 'link').forEach(enqueue);
              if (await this.inspect(snapshot, false, signal)) {
                this.done('direct_evidence');
                return;
              }
            } catch (error) {
              if (error instanceof VerificationError) throw error;
              signal.throwIfAborted();
              this.state.coverage.checkedPages!.push({
                url: key,
                title: candidate.label,
                outcome: 'fetch_failed',
              });
              this.limitation('fetch_or_policy_blocked');
              this.state.coverage.blocked++;
            }
          }
          if (frontier.size && this.publicAttempts >= this.limits.maxPages) {
            this.limitation('budget_reached');
            this.emit('limit_reached');
          } else if (!frontier.size) this.state.coverage.scope = 'frontier_exhausted_within_scope';
        } catch (error) {
          if (error instanceof VerificationError) throw error;
          signal.throwIfAborted();
          this.limitation('public_search_unavailable');
        }
      } else if (request.scope === 'site') this.limitation('public_url_not_eligible');
      if (request.scope === 'site' && this.publicAttempts >= this.limits.maxPages) {
        this.done('page_budget_reached');
        return;
      }
      this.done(
        this.publicAttempts >= this.limits.maxPages ? 'page_budget_reached' : 'search_finished',
      );
    } catch (error) {
      if (this.state.lifecycle === 'cancelled') return;
      if (signal.aborted) {
        this.limitation('budget_reached');
        this.done('deadline_reached');
      } else {
        this.state.lifecycle = 'failed';
        this.state.coverage.stopReason =
          error instanceof VerificationError ? error.reason : 'search_failed';
        this.state.message =
          error instanceof VerificationError
            ? verificationMessages[error.reason]
            : 'Search could not finish. Try again.';
        this.request = undefined;
        this.emit('error');
      }
    } finally {
      clearTimeout(timer);
      this.activeTime += Date.now() - start;
      this.state.coverage.elapsedMs = this.activeTime;
    }
  }
}

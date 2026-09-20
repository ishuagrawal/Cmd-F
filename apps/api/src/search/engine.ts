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
  type Assessment,
  type SearchIntent,
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
  private publicPages = 0;
  private intent?: SearchIntent;
  private assessed = new Map<string, Assessment>();
  private assessedRoutes = new Map<string, Assessment>();
  private observedCandidates = new Set<string>();
  private observedLinks = new Set<string>();
  private localTurns = 0;
  private localInventory = { candidates: 0, links: 0 };
  private localObserved = new Set<string>();
  private localObservedLinks = new Set<string>();
  private localLinks = new Map<string, Candidate>();
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
        fetchAttempts: 0,
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
    this.state.coverage.candidatesAssessed = this.assessed.size;
    this.state.coverage.candidatesObserved =
      this.observedCandidates.size +
      Math.max(0, this.localInventory.candidates - this.localObserved.size);
    this.state.coverage.linksObserved =
      this.observedLinks.size +
      Math.max(0, this.localInventory.links - this.localObservedLinks.size);
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
          ? 'Matching listings found. Destination details have not been verified.'
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
    if (
      [
        'deadline_reached',
        'page_budget_reached',
        'fetch_budget_reached',
        'provider_budget_exhausted',
      ].includes(reason)
    ) {
      this.state.message = this.state.results.length
        ? 'Search limit reached. Matches found so far are shown.'
        : 'Search limit reached before a match was verified.';
    }
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
    if (this.state.revealSteps >= 24) throw new Error('reveal_budget');
    this.state.revealSteps++;
    if (snapshot.id !== this.request.snapshot.id) this.localLinks.clear();
    this.state.results = this.state.results.filter((r) => r.snapshotId === snapshot.id);
    this.request.snapshot = sanitizeSnapshot(snapshot);
    this.state.requestedSections = [];
    this.state.lifecycle = 'running';
    this.state.evidence = this.state.results[0]?.evidence || 'none';
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
        intent: this.intent,
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
  private followable(assessment: Assessment | undefined) {
    if (!assessment || assessment.disposition === 'irrelevant') return false;
    return this.intent !== 'items' || assessment.disposition === 'route';
  }
  private listing(snapshot: PageSnapshot, assessment: Assessment, local: boolean) {
    const c = assessment.candidate;
    if (
      c.kind !== 'link' ||
      assessment.disposition !== 'match' ||
      !c.safeUrl ||
      c.actionPolicy !== 'read_candidate' ||
      c.provenance === 'sitemap' ||
      c.visibility === 'hidden' ||
      c.disabled ||
      c.truncated
    )
      return;
    this.add({
      id: `${snapshot.id}:${c.id}`,
      kind: 'listing',
      title: c.label,
      url: c.safeUrl,
      origin: snapshot.origin,
      quote: c.label,
      headingPath: c.headingPath,
      observedAt: snapshot.observedAt,
      evidence: 'candidate_only',
      candidate: c,
      snapshotId: snapshot.id,
      documentId: snapshot.documentId,
      local,
      provider: this.provider.mode,
      model: assessment.model,
    });
  }
  private async screen(snapshot: PageSnapshot, candidates: Candidate[], signal: AbortSignal) {
    const unseen = candidates.filter((c) => !this.assessed.has(`${c.snapshotId}:${c.id}`));
    if (unseen.length && this.provider.screen) {
      try {
        const decisions = await this.provider.screen(
          this.request!.question,
          unseen,
          signal,
          this.budget,
          {
            intent: this.intent,
            sourceTitle: this.request!.snapshot.title,
            sourceUrl: this.request!.snapshot.url,
            inspectedPage: { title: snapshot.title, url: snapshot.url },
          },
        );
        signal.throwIfAborted();
        for (const decision of decisions) {
          // Bind returned judgments to the exact supplied immutable record.
          const candidate = unseen.find((c) => c.id === decision.candidate.id);
          if (!candidate) continue;
          const assessment: Assessment = {
            ...decision,
            candidate,
            disposition:
              this.intent === 'information' &&
              candidate.kind === 'link' &&
              decision.disposition === 'match'
                ? 'route'
                : decision.disposition,
          };
          this.assessed.set(`${candidate.snapshotId}:${candidate.id}`, assessment);
          if (candidate.safeUrl)
            this.assessedRoutes.set(urlIdentity(candidate.safeUrl).fetchKey, assessment);
        }
      } catch (error) {
        signal.throwIfAborted();
        const reason = providerFailureReason(error);
        this.limitation(reason);
        throw new VerificationError(reason);
      }
    }
    return candidates
      .map((c) => this.assessed.get(`${c.snapshotId}:${c.id}`))
      .filter((a): a is Assessment => !!a);
  }
  private async inspect(snapshot: PageSnapshot, local: boolean, signal: AbortSignal) {
    const trace = {
      url: snapshot.url,
      title: snapshot.title,
      outcome: 'checking' as NonNullable<
        SearchState['coverage']['checkedPages']
      >[number]['outcome'],
    };
    const previous = this.state.coverage.checkedPages!.find(
      (p) => p.url === trace.url && p.title === trace.title,
    );
    if (previous)
      this.state.coverage.checkedPages!.splice(
        this.state.coverage.checkedPages!.indexOf(previous),
        1,
      );
    this.state.coverage.checkedPages!.push(trace);
    let remaining = snapshot.candidates.filter(
      (c) =>
        (c.kind === 'passage' || (local && c.kind === 'control')) &&
        !c.disabled &&
        c.visibility !== 'hidden' &&
        !c.truncated &&
        (!c.textRole || c.textRole === 'body' || !!this.provider.screen),
    );
    const links = snapshot.candidates.filter(
      (c) =>
        c.kind === 'link' &&
        !c.disabled &&
        c.visibility !== 'hidden' &&
        !c.truncated &&
        c.safeUrl &&
        c.actionPolicy === 'read_candidate',
    );
    const failuresBefore = this.budget.validationFailures?.length || 0;
    const all = [...remaining, ...links];
    all.forEach((c) => {
      this.observedCandidates.add(`${snapshot.id}:${c.id}`);
      if (c.kind === 'link') this.observedLinks.add(`${snapshot.id}:${c.id}`);
      if (local) {
        this.localObserved.add(c.id);
        if (c.kind === 'link') this.localObservedLinks.add(c.id);
      }
    });
    this.state.message = local
      ? 'Finding relevant text and links'
      : `Reading ${snapshot.title || 'linked page'}`;
    this.emit('candidate_found');
    const ordered = rank(this.request!.question, all).map((x) => x.candidate);
    const waves = this.provider.screen ? Math.ceil(ordered.length / 48) : 1;
    for (let wave = 0; wave < waves; wave++) {
      if (this.provider.screen) {
        const judgments = await this.screen(
          snapshot,
          ordered.slice(wave * 48, (wave + 1) * 48),
          signal,
        );
        const matches = judgments
          .filter((a) => a.disposition === 'match')
          .sort((a, b) => b.relevance - a.relevance);
        for (const match of matches) this.listing(snapshot, match, local);
        remaining = matches.filter((a) => a.candidate.kind !== 'link').map((a) => a.candidate);
        this.emit('candidate_found');
      }
      for (let attempt = 0; remaining.length && attempt < 3; attempt++) {
        const batch: Candidate[] = [];
        let bytes = 0;
        for (const c of shortlist(this.request!.question, remaining, 16)) {
          const size = Buffer.byteLength(JSON.stringify(c));
          if (batch.length && bytes + size > 18000) break;
          batch.push(c);
          bytes += size;
        }
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
      if (this.state.results.filter((r) => r.kind === 'listing').length >= 3) {
        if (wave + 1 < waves) this.limitation('more_candidates');
        break;
      }
    }
    trace.outcome =
      (this.budget.validationFailures?.length || 0) > failuresBefore
        ? 'verification_failed'
        : this.state.results.some((r) => r.snapshotId === snapshot.id && r.kind === 'listing')
          ? 'matched_links'
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
    const sourceText = c.text || c.label;
    const excerpt = d.excerpt;
    if (
      excerpt &&
      (!Number.isInteger(excerpt.start) ||
        !Number.isInteger(excerpt.end) ||
        excerpt.start < 0 ||
        excerpt.end <= excerpt.start ||
        excerpt.end > sourceText.length)
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
      quote: excerpt ? sourceText.slice(excerpt.start, excerpt.end) : sourceText,
      excerpt,
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
      if (current.discovery) this.localInventory = current.discovery;
      if (/^(just a moment[.!…]*|checking your browser|access denied)/i.test(current.title)) {
        this.limitation('blocked');
        this.state.coverage.checkedPages!.push({
          url: current.url,
          title: current.title,
          outcome: 'blocked',
        });
        this.done('page_blocked');
        return;
      }
      current.limitations.forEach((x) => this.limitation(x));
      if (!this.intent && this.provider.interpret) {
        this.state.message = 'Understanding your request';
        this.emit('candidate_found');
        try {
          this.intent = await this.provider.interpret(request.question, signal, this.budget, {
            sourceTitle: current.title,
            sourceUrl: current.url,
          });
        } catch (error) {
          signal.throwIfAborted();
          throw new VerificationError(providerFailureReason(error));
        }
      }
      if (this.state.coverage.pagesChecked === 0) this.state.coverage.pagesChecked++;
      current.candidates
        .filter((c) => c.kind === 'link')
        .forEach((c) => this.localLinks.set(c.id, c));
      await this.inspect(current, true, signal);
      this.emit('snapshot_checked');
      if (this.state.evidence === 'direct') {
        this.done('direct_evidence');
        return;
      }
      const groups = current.candidates.filter((c) => c.kind === 'group');
      const matchingListings = this.state.results.filter((r) => r.kind === 'listing').length;
      if (matchingListings >= 3 && (request.scope === 'page' || this.intent === 'items')) {
        if (groups.length) this.limitation('more_local_candidates');
        this.done('matches_found');
        return;
      }
      // Read omitted local records without spending model calls on section labels.
      // Site searches get an early route opportunity, then continue their frontier.
      if (
        groups.length &&
        this.state.revealSteps < 24 &&
        (request.scope === 'page' ||
          (this.localTurns < 2 &&
            !matchingListings &&
            ![...this.assessedRoutes.values()].some((a) => a.disposition !== 'irrelevant')))
      ) {
        this.localTurns++;
        this.state.lifecycle = 'waiting_for_user';
        this.state.requestedSections = rank(request.question, groups)
          .slice(0, 4)
          .map((x) => x.candidate.sectionId!)
          .filter((id) => current.sectionIds.includes(id));
        if (this.state.requestedSections.length) {
          this.state.message = 'Reading more of this page';
          this.emit('needs_local_content');
          return;
        }
        this.state.lifecycle = 'running';
      }
      if (groups.length) this.limitation('more_local_candidates');
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
        const blockedOrigins = new Set<string>();
        const originBlocks = new Map<string, number>();
        const originOf = (url: string) => {
          try {
            return new URL(url).origin;
          } catch {
            return '';
          }
        };
        const dropOrigin = (origin: string) => {
          blockedOrigins.add(origin);
          for (const [k, c] of frontier)
            if (c.safeUrl && originOf(c.safeUrl) === origin) frontier.delete(k);
        };
        const noteBlock = (origin: string) => {
          const n = (originBlocks.get(origin) || 0) + 1;
          originBlocks.set(origin, n);
          if (n < 2) return;
          const otherOrigin = [...frontier.values()].some((c) => {
            const next = c.safeUrl && originOf(c.safeUrl);
            return next && next !== origin && !blockedOrigins.has(next);
          });
          if (otherOrigin) dropOrigin(origin);
        };

        const depths = new Map<string, number>();
        const enqueue = (c: Candidate, depth = 1, parentOrigin = current.origin) => {
          if (!c.safeUrl) return;
          const safe = shareableUrl(c.safeUrl);
          if (!safe || actionPolicy(safe) !== 'read_candidate') {
            this.state.coverage.blocked++;
            return;
          }
          const { fetchKey, routeKey } = urlIdentity(safe);
          if (blockedOrigins.has(originOf(safe))) return;
          if (routeKey.includes('#/') || routeKey.includes('#!')) {
            this.limitation('rendering_needed');
            return;
          }
          if (
            depth > 4 ||
            (parentOrigin !== current.origin && new URL(safe).origin !== parentOrigin)
          )
            return;
          if (visited.has(fetchKey) || frontier.has(fetchKey)) return;
          if (this.discoveredPublic.size >= this.limits.maxUrls) {
            this.limitation('url_budget_reached');
            return;
          }
          frontier.set(fetchKey, c);
          depths.set(fetchKey, depth);
          this.discoveredPublic.add(fetchKey);
          this.state.coverage.urlsDiscovered = this.discoveredPublic.size;
        };
        this.localLinks.forEach((c) => enqueue(c));
        this.emit('page_discovered');
        try {
          const robotPolicies = new Map<string, Awaited<ReturnType<typeof loadRobots>>>();
          const robotFailures = new Set<string>();
          const policyFor = async (origin: string) => {
            if (robotFailures.has(origin)) throw new Error('robots_unreachable');
            if (!robotPolicies.has(origin)) {
              try {
                robotPolicies.set(origin, await loadRobots(this.fetcher, origin, signal));
              } catch (error) {
                robotFailures.add(origin);
                throw error;
              }
            }
            return robotPolicies.get(origin)!;
          };
          let mapsLoaded = false;
          const expandSitemaps = async () => {
            mapsLoaded = true;
            if (blockedOrigins.has(current.origin)) return;
            let robots: Awaited<ReturnType<typeof loadRobots>>;
            try {
              robots = await policyFor(current.origin);
            } catch {
              signal.throwIfAborted();
              this.limitation('robots_unavailable');
              return;
            }
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
          const lastStarts = new Map<string, number>();
          while (
            this.publicPages < this.limits.maxPages &&
            this.publicAttempts < this.limits.maxPages * 2
          ) {
            if (!frontier.size && !mapsLoaded) await expandSitemaps();
            if (!frontier.size) break;
            signal.throwIfAborted();
            const usable = [...frontier.values()].filter(
              (c) => c.safeUrl && !blockedOrigins.has(originOf(c.safeUrl)),
            );
            if (!usable.length) {
              if (!mapsLoaded) await expandSitemaps();
              else break;
              continue;
            }
            let ordered = rankRoutes(request.question, usable, current);
            if (!mapsLoaded && !(ordered[0]?.score > 0)) {
              await expandSitemaps();
              ordered = rankRoutes(
                request.question,
                [...frontier.values()].filter(
                  (c) => c.safeUrl && !blockedOrigins.has(originOf(c.safeUrl)),
                ),
                current,
              );
            }
            const routeId = (c: Candidate) => urlIdentity(c.safeUrl!).fetchKey;
            const relevanceOf = (c: Candidate) => this.assessedRoutes.get(routeId(c))?.relevance || 0;
            let candidate: Candidate | undefined;
            if (this.provider.screen) {
              // Reuse judgments made while inspecting pages. Screen new routes in
              // bounded waves; never let a lexical zero or one abstention end discovery.
              const known = ordered
                .filter((x) => this.followable(this.assessedRoutes.get(routeId(x.candidate))))
                .sort(
                  (a, b) =>
                    relevanceOf(b.candidate) - relevanceOf(a.candidate) || b.score - a.score,
                );
              const unseen = ordered.filter(
                (x) => !this.assessedRoutes.has(routeId(x.candidate)),
              );
              if (known.length) candidate = known[0].candidate;
              else if (unseen.length) {
                const buckets = new Map<string, Candidate[]>();
                for (const x of unseen) {
                  const origin = originOf(x.candidate.safeUrl!);
                  const list = buckets.get(origin) || [];
                  list.push(x.candidate);
                  buckets.set(origin, list);
                }
                const routes: Candidate[] = [];
                const queues = [...buckets.values()];
                while (routes.length < 48 && queues.some((q) => q.length)) {
                  for (const q of queues) {
                    if (routes.length >= 48) break;
                    const next = q.shift();
                    if (next) routes.push(next);
                  }
                }
                await this.screen(current, routes, signal);
                candidate = [...routes]
                  .filter((c) => this.followable(this.assessedRoutes.get(routeId(c))))
                  .sort((a, b) => relevanceOf(b) - relevanceOf(a))[0];
                if (!candidate) {
                  routes.forEach((c) => frontier.delete(routeId(c)));
                  continue;
                }
              } else {
                if (!mapsLoaded) {
                  await expandSitemaps();
                  continue;
                }
                break;
              }
            } else {
              const choice = await this.decide(
                request.question,
                ordered.slice(0, 24).map((x) => x.candidate),
                signal,
                'route',
              );
              candidate = choice.candidate || ordered[0]?.candidate;
            }
            if (!candidate) break;
            const key = urlIdentity(candidate.safeUrl!).fetchKey;
            frontier.delete(key);
            visited.add(key);
            const targetOrigin = new URL(key).origin;
            let robots: Awaited<ReturnType<typeof loadRobots>>;
            try {
              robots = await policyFor(targetOrigin);
            } catch {
              signal.throwIfAborted();
              this.limitation('robots_unavailable');
              this.state.coverage.blocked++;
              this.state.coverage.checkedPages!.push({
                url: key,
                title: candidate.label,
                outcome: 'blocked',
              });
              dropOrigin(targetOrigin);
              continue;
            }
            if (!robots.allows(key)) {
              this.state.coverage.blocked++;
              this.limitation('robots_disallowed');
              this.state.coverage.checkedPages!.push({
                url: key,
                title: candidate.label,
                outcome: 'blocked',
              });
              continue;
            }
            const gap = robots.delay - (Date.now() - (lastStarts.get(targetOrigin) || 0));
            if (gap > 0)
              await new Promise<void>((resolve, reject) => {
                const onAbort = () => {
                  clearTimeout(t);
                  reject(new Error('cancelled'));
                };
                const t = setTimeout(() => {
                  signal.removeEventListener('abort', onAbort);
                  resolve();
                }, gap);
                signal.addEventListener('abort', onAbort, { once: true });
                if (signal.aborted) onAbort();
              });
            signal.throwIfAborted();
            lastStarts.set(targetOrigin, Date.now());
            this.publicAttempts++;
            this.state.coverage.fetchAttempts = this.publicAttempts;
            try {
              let artifact = request.refresh ? undefined : this.cache.get(key);
              if (artifact) this.state.coverage.cacheHits++;
              else
                artifact = await this.fetcher.get(
                  key,
                  targetOrigin,
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
                noteBlock(targetOrigin);
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
              this.publicPages++;
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
                noteBlock(targetOrigin);
                continue;
              }
              this.cache.put(artifact);
              snapshot.limitations.forEach((x) => this.limitation(x));
              const fingerprint = snapshot.candidates.map((x) => x.contentHash).join('-');
              if (seenContent.has(fingerprint)) continue;
              seenContent.add(fingerprint);
              snapshot.candidates
                .filter((c) => c.kind === 'link')
                .forEach((c) => enqueue(c, (depths.get(key) || 1) + 1, snapshot.origin));
              if (await this.inspect(snapshot, false, signal)) {
                this.done('direct_evidence');
                return;
              }
              if (
                this.intent === 'items' &&
                this.state.results.filter((r) => r.kind === 'listing').length >= 3
              ) {
                this.done('matches_found');
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
          if (
            frontier.size &&
            (this.publicPages >= this.limits.maxPages ||
              this.publicAttempts >= this.limits.maxPages * 2)
          ) {
            this.limitation('budget_reached');
            this.emit('limit_reached');
          } else if (!frontier.size) this.state.coverage.scope = 'frontier_exhausted_within_scope';
        } catch (error) {
          if (error instanceof VerificationError) throw error;
          signal.throwIfAborted();
          this.limitation('public_search_unavailable');
        }
      } else if (request.scope === 'site') this.limitation('public_url_not_eligible');
      if (
        request.scope === 'site' &&
        (this.publicPages >= this.limits.maxPages ||
          this.publicAttempts >= this.limits.maxPages * 2)
      ) {
        this.done(
          this.publicPages >= this.limits.maxPages ? 'page_budget_reached' : 'fetch_budget_reached',
        );
        return;
      }
      this.done(
        this.publicPages >= this.limits.maxPages || this.publicAttempts >= this.limits.maxPages * 2
          ? this.publicPages >= this.limits.maxPages
            ? 'page_budget_reached'
            : 'fetch_budget_reached'
          : 'search_finished',
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

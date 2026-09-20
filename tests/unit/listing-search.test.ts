import { expect, it, vi } from 'vitest';
import { SearchSession, defaultLimits } from '../../apps/api/src/search/engine';
import { SafeFetcher } from '../../apps/api/src/fetch/safe-fetch';
import { publicNetworkPolicy } from '../../packages/security/src/network';
import { PublicCache } from '../../apps/api/src/cache/public-cache';
import { extractHtml } from '../../packages/extraction/src/html';
import { StateSchema } from '../../packages/contracts/src';
import { MockProvider, type Provider } from '../../packages/jev/src';

const provider: Provider = {
  mode: 'jev',
  screen: new MockProvider().screen,
  async select(_q, candidates, _s, _b, purpose) {
    const candidate =
      purpose === 'route'
        ? candidates[0]
        : candidates.find((c) => c.text?.includes('Verified destination detail'));
    return { candidate, mode: 'jev', support: candidate ? 0.9 : 0, verified: !!candidate };
  },
};
async function run({
  html = '<a href="/jobs/software">Software engineer</a>',
  question = 'software engineer',
  scope = 'site' as 'page' | 'site',
  pages = {} as Record<string, string>,
  maxPages = 2,
  select = provider,
  mutate = (_s: ReturnType<typeof extractHtml>) => {},
} = {}) {
  const origin = 'https://example.com';
  const snapshot = extractHtml(html, origin + '/careers');
  snapshot.candidates.forEach((c) => {
    c.provenance = 'live_dom';
  });
  mutate(snapshot);
  const fetcher = new SafeFetcher(publicNetworkPolicy);
  const visited: string[] = [];
  vi.spyOn(fetcher, 'get').mockImplementation(async (url) => {
    const path = new URL(url).pathname;
    visited.push(path);
    return {
      url,
      body: pages[path] || '',
      status: path in pages ? 200 : 403,
      headers: { 'content-type': 'text/html' },
      retrievedAt: new Date().toISOString(),
    };
  });
  const cache = new PublicCache();
  const session = new SearchSession(
    'test',
    {
      protocol: 1,
      question,
      scope,
      snapshot,
      consent: true,
      publicSearchConsent: scope === 'site',
      refresh: true,
    },
    select,
    fetcher,
    cache,
    { ...defaultLimits, maxPages },
  );
  try {
    await session.run();
    StateSchema.parse(session.state);
    return { state: session.state, visited };
  } finally {
    cache.close();
  }
}
it('retains an observed listing when its destination is blocked without claiming evidence', async () => {
  const { state } = await run({ pages: { '/robots.txt': '' } });
  expect(state.results[0]).toMatchObject({
    kind: 'listing',
    evidence: 'candidate_only',
    quote: 'Software engineer',
    local: true,
  });
  expect(state.evidence).toBe('candidate_only');
  expect(state.message).toContain('not been verified');
});
it('continues through a matching listing and a second hop to verified destination content', async () => {
  const { state, visited } = await run({
    pages: {
      '/robots.txt': '',
      '/jobs/software': '<a href="/details">Software engineer details</a>',
      '/details': '<p>Verified destination detail about software engineer roles.</p>',
    },
  });
  expect(visited).toContain('/details');
  expect(state.results[0]).toMatchObject({
    kind: 'page',
    evidence: 'direct',
    url: 'https://example.com/details',
  });
  expect(state.coverage.stopReason).toBe('direct_evidence');
});
it('page scope returns a matching listing without making public requests', async () => {
  const { state, visited } = await run({ scope: 'page' });
  expect(state.results[0].kind).toBe('listing');
  expect(visited).toEqual([]);
});
it('keeps information requests from becoming link-title answers even after a screening mistake', async () => {
  const { state, visited } = await run({
    scope: 'page',
    question: 'salary of software engineers',
    select: {
      ...provider,
      interpret: async () => 'information',
      screen: async (_q, candidates) =>
        candidates.map((candidate) => ({
          candidate,
          disposition: 'match' as const,
          relevance: 1,
        })),
    },
  });
  expect(state.results).toEqual([]);
  expect(visited).toEqual([]);
});
it.each(['What is the software engineer salary?', 'How do cycles repeat?', 'rainfall'])(
  'does not present title overlap as an answer to %s',
  async (question) => {
    const { state } = await run({ question, scope: 'page' });
    expect(state.results).toEqual([]);
  },
);
it('excludes hidden, disabled, unsafe and sitemap links from listings', async () => {
  for (const attrs of [
    { visibility: 'hidden' },
    { disabled: true },
    { provenance: 'sitemap' },
    { actionPolicy: 'needs_review', safeUrl: 'https://example.com/logout' },
  ]) {
    const { state } = await run({
      scope: 'page',
      mutate: (s) => {
        Object.assign(s.candidates[0], attrs);
      },
    });
    expect(state.results).toEqual([]);
  }
});
it('can reach a valid page after the old attempt budget would have expired', async () => {
  const { state, visited } = await run({
    maxPages: 2,
    html: '<a href="/bad1">Software engineer one</a><a href="/bad2">Software engineer two</a><a href="/good">Software engineer three</a>',
    pages: {
      '/robots.txt': '',
      '/good': '<p>Verified destination detail about software engineer roles.</p>',
    },
  });
  expect(visited).toContain('/good');
  expect(state.evidence).toBe('direct');
  expect(state.coverage).toMatchObject({ fetchAttempts: 3, pagesChecked: 2 });
});
it('bounds repeated access failures independently of pages checked', async () => {
  const { state } = await run({
    maxPages: 2,
    html: Array.from({ length: 8 }, (_, i) => `<a href="/bad${i}">Software engineer ${i}</a>`).join(
      '',
    ),
    pages: { '/robots.txt': '' },
  });
  expect(state.coverage).toMatchObject({
    fetchAttempts: 4,
    pagesChecked: 1,
    stopReason: 'fetch_budget_reached',
  });
  expect(state.results).toHaveLength(3);
});
it('keeps listing results visible even when the provider becomes unavailable', async () => {
  const { state } = await run({
    html: '<a href="/jobs/software">Software engineer</a><p>Software engineer responsibilities.</p>',
    select: {
      mode: 'jev',
      screen: new MockProvider().screen,
      async select() {
        throw new Error('provider_http_429');
      },
    },
  });
  expect(state.lifecycle).toBe('failed');
  expect(state.results[0].kind).toBe('listing');
});

it('finds a zero-overlap candidate beyond the old two-window cutoff', async () => {
  const seen: string[] = [];
  const { state } = await run({
    scope: 'page',
    question: 'get my money back',
    html: Array.from(
      { length: 130 },
      (_, i) => `<a href="/item${i}">${i === 129 ? 'Returns and reimbursements' : `Item ${i}`}</a>`,
    ).join(''),
    select: {
      ...provider,
      async screen(_q, cs) {
        seen.push(...cs.map((c) => c.label));
        return cs.map((candidate) => ({
          candidate,
          disposition: candidate.label === 'Returns and reimbursements' ? 'match' : 'irrelevant',
          relevance: 1,
        }));
      },
    },
  });
  expect(seen).toHaveLength(130);
  expect(state.results[0].quote).toBe('Returns and reimbursements');
  expect(state.coverage.candidatesAssessed).toBe(130);
});
it('can follow an observed external route and recurse within that destination origin', async () => {
  const { state, visited } = await run({
    question: 'software engineer salary',
    html: '<a href="https://jobs.example.org/opening">Software engineer</a>',
    pages: {
      '/robots.txt': '',
      '/opening': '<a href="/compensation">Salary details</a>',
      '/compensation': '<p>Verified destination detail: software engineer salary is $100,000.</p>',
    },
    select: {
      ...provider,
      async screen(_q, cs) {
        return cs.map((candidate) => ({
          candidate,
          disposition:
            candidate.kind === 'link'
              ? 'route'
              : candidate.text?.includes('Verified destination detail')
                ? 'match'
                : 'irrelevant',
          relevance: 1,
        }));
      },
    },
  });
  expect(visited).toContain('/compensation');
  expect(state.results[0]).toMatchObject({
    kind: 'page',
    evidence: 'direct',
    url: 'https://jobs.example.org/compensation',
  });
});
it('page scope never fetches an external route', async () => {
  const { state, visited } = await run({
    scope: 'page',
    html: '<a href="https://jobs.example.org/opening">Software engineer</a>',
    select: {
      ...provider,
      async screen(_q, cs) {
        return cs.map((candidate) => ({ candidate, disposition: 'route', relevance: 0 }));
      },
    },
  });
  expect(state.results).toEqual([]);
  expect(visited).toEqual([]);
});
it('an external destination cannot expand the crawl onto a third site', async () => {
  const { state, visited } = await run({
    question: 'salary',
    html: '<a href="https://jobs.example.org/opening">Salary</a>',
    pages: {
      '/robots.txt': '',
      '/opening': '<a href="https://unrelated.example.net/private-offer">Salary offer</a>',
    },
    select: {
      ...provider,
      async screen(_q, cs) {
        return cs.map((candidate) => ({ candidate, disposition: 'route', relevance: 0 }));
      },
    },
  });
  expect(visited).not.toContain('/private-offer');
  expect(state.results).toEqual([]);
});
it('navigation labels can be semantic results rather than being excluded by their region', async () => {
  const { state } = await run({
    scope: 'page',
    html: '<nav><a href="/jobs/software">Software engineer</a></nav>',
  });
  expect(state.results[0].kind).toBe('listing');
});

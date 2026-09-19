import { it, expect, vi } from 'vitest';
import { SearchSession, defaultLimits } from '../../apps/api/src/search/engine';
import { SafeFetcher } from '../../apps/api/src/fetch/safe-fetch';
import { publicNetworkPolicy } from '../../packages/security/src/network';
import { PublicCache } from '../../apps/api/src/cache/public-cache';
import { extractHtml } from '../../packages/extraction/src/html';
import { rankRoutes } from '../../packages/retrieval/src';
import type { Provider } from '../../packages/jev/src';

async function run(
  html: string,
  pages: Record<string, string>,
  provider: Provider,
  scope: 'page' | 'site' = 'site',
) {
  const origin = 'https://docs.example.com';
  const fetcher = new SafeFetcher(publicNetworkPolicy);
  const visited: string[] = [];
  vi.spyOn(fetcher, 'get').mockImplementation(async (url) => {
    const path = new URL(url).pathname;
    visited.push(path);
    return {
      url,
      body: pages[path] || '',
      status: path in pages ? 200 : 404,
      headers: { 'content-type': 'text/html' },
      retrievedAt: new Date().toISOString(),
    };
  });
  const cache = new PublicCache();
  const session = new SearchSession(
    'test',
    {
      protocol: 1,
      question: 'how to grow herbs',
      scope,
      snapshot: extractHtml(html, origin + '/garden/start'),
      consent: true,
      publicSearchConsent: true,
      refresh: true,
    },
    provider,
    fetcher,
    cache,
    { ...defaultLimits, maxPages: 3 },
  );
  try {
    await session.run();
    return { state: session.state, visited };
  } finally {
    cache.close();
  }
}
const abstainingRouter: Provider = {
  mode: 'jev',
  async select(_q, candidates, _s, _b, purpose) {
    const candidate =
      purpose !== 'route'
        ? candidates.find((c) => c.text?.includes('Plant herbs in well-drained soil.'))
        : undefined;
    return { mode: 'jev', candidate, verified: !!candidate, support: candidate ? 0.9 : 0 };
  },
};
it('follows a multi-hop route after model abstentions and verifies the actual passage', async () => {
  const { state, visited } = await run(
    '<a href="/garden/herbs">Herbs guide</a>',
    {
      '/garden/herbs': '<p>Herbs index.</p><a href="/garden/growing">Growing herbs</a>',
      '/garden/growing': '<p>Plant herbs in well-drained soil.</p>',
    },
    abstainingRouter,
  );
  expect(state.evidence).toBe('direct');
  expect(state.results[0].quote).toBe('Plant herbs in well-drained soil.');
  expect(visited).toEqual(['/robots.txt', '/garden/herbs', '/garden/growing']);
  expect(state.coverage.checkedPages?.map((p) => p.outcome)).toEqual([
    'no_evidence',
    'no_evidence',
    'verified',
  ]);
});
it('expands sitemaps when observed links do not match the request', async () => {
  const { state, visited } = await run(
    '<p>Welcome to our garden.</p>',
    {
      '/robots.txt': 'User-agent: *\nAllow: /\nSitemap: https://docs.example.com/map.xml',
      '/map.xml': '<urlset><url><loc>https://docs.example.com/garden/herbs</loc></url></urlset>',
      '/garden/herbs': '<p>Plant herbs in well-drained soil.</p>',
    },
    abstainingRouter,
  );
  expect(state.evidence).toBe('direct');
  expect(visited).toContain('/map.xml');
});
it('tries another passage after a rejected selection without presenting the rejected text', async () => {
  let calls = 0;
  const { state } = await run(
    '<p>Herbs are interesting.</p><p>Plant herbs in well-drained soil.</p>',
    {},
    {
      mode: 'jev',
      async select(_q, candidates) {
        calls++;
        return { mode: 'jev', candidate: candidates[0], verified: calls > 1, support: 0.9 };
      },
    },
    'page',
  );
  expect(calls).toBe(2);
  expect(state.results[0].quote).toBe('Plant herbs in well-drained soil.');
});
it('records inaccessible pages separately and keeps searching', async () => {
  const { state } = await run(
    '<a href="/missing">Grow herbs</a><a href="/garden/herbs">Herbs</a>',
    {
      '/garden/herbs': '<p>Plant herbs in well-drained soil.</p>',
    },
    abstainingRouter,
  );
  expect(state.evidence).toBe('direct');
  expect(state.coverage.checkedPages?.some((p) => p.outcome === 'fetch_failed')).toBe(true);
});
it('keeps source verification mandatory when routes only match keywords', async () => {
  const { state } = await run(
    '<a href="/garden/herbs">Growing herbs</a>',
    {
      '/garden/herbs': '<p>Unrelated content.</p>',
    },
    abstainingRouter,
  );
  expect(state.results).toEqual([]);
});
it('uses subject context for competing route labels without overriding explicit topics', () => {
  const page = extractHtml(
    '<a href="/programming/sets">Programming Sets</a><a href="/garden/sets">Garden Sets</a>',
    'https://example.com/garden/start',
  );
  const context = { title: 'Garden basics', url: page.url };
  expect(rankRoutes('sets', page.candidates, context)[0].candidate.label).toBe('Garden Sets');
  expect(rankRoutes('programming sets', page.candidates, context)[0].candidate.label).toBe(
    'Programming Sets',
  );
});

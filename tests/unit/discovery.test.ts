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
it('uses the destination host when ranking otherwise identical route labels', () => {
  const candidates = ['https://docs.example.com/start', 'https://herbs.example.com/start'].map(
    (safeUrl) => ({
      label: 'Overview',
      text: '',
      context: '',
      headingPath: [] as string[],
      safeUrl,
    }),
  );
  expect(
    rankRoutes('herbs', candidates, {
      title: 'Docs',
      url: 'https://docs.example.com/index/start',
    })[0].candidate.safeUrl,
  ).toBe('https://herbs.example.com/start');
});

async function runHosts(
  html: string,
  pages: Record<string, { body?: string; status?: number }>,
  provider: Provider,
  question: string,
  maxPages = 3,
) {
  const origin = 'https://news.example.com';
  const fetcher = new SafeFetcher(publicNetworkPolicy);
  const visited: string[] = [];
  vi.spyOn(fetcher, 'get').mockImplementation(async (url) => {
    visited.push(url);
    const page = pages[url];
    const robots = url.endsWith('/robots.txt');
    return {
      url,
      body: page?.body || (robots ? 'User-agent: *\nAllow: /\n' : ''),
      status: page?.status ?? (robots || page ? 200 : 404),
      headers: { 'content-type': robots ? 'text/plain' : 'text/html' },
      retrievedAt: new Date().toISOString(),
    };
  });
  const cache = new PublicCache();
  const session = new SearchSession(
    'test',
    {
      protocol: 1,
      question,
      scope: 'site',
      snapshot: extractHtml(html, origin + '/index/gpt-6-astra'),
      consent: true,
      publicSearchConsent: true,
      refresh: true,
    },
    provider,
    fetcher,
    cache,
    { ...defaultLimits, maxPages },
  );
  try {
    await session.run();
    return { state: session.state, visited };
  } finally {
    cache.close();
  }
}
const quote = 'Following the Hugging Face incident, we implemented strict controls.';
it('follows the most relevant outbound host before same-path siblings', async () => {
  const siblings = Array.from({ length: 3 }, (_, i) => `/index/astra-note-${i}`);
  const html = [
    ...siblings.map((path) => `<a href="${path}">Astra notes</a>`),
    '<a href="https://safety.example.com/gpt-6-astra">Astra system card</a>',
  ].join('');
  const pages: Record<string, { body?: string; status?: number }> = {
    'https://safety.example.com/gpt-6-astra': { body: `<p>${quote}</p>` },
  };
  for (const path of siblings)
    pages[`https://news.example.com${path}`] = { body: '<p>Astra product update.</p>' };
  const { state, visited } = await runHosts(
    html,
    pages,
    {
      mode: 'jev',
      async screen(_q, candidates) {
        return candidates.map((candidate) => ({
          candidate,
          disposition:
            candidate.kind === 'link'
              ? 'route'
              : candidate.text?.includes('Hugging Face incident')
                ? 'match'
                : 'irrelevant',
          relevance: /system card/i.test(candidate.label)
            ? 0.9
            : candidate.text?.includes('Hugging Face incident')
              ? 0.9
              : 0.1,
        }));
      },
      async select(_q, candidates, _s, _b, purpose) {
        const candidate =
          purpose === 'route'
            ? candidates[0]
            : candidates.find((c) => c.text?.includes('Hugging Face incident'));
        return { mode: 'jev', candidate, verified: !!candidate, support: candidate ? 0.9 : 0 };
      },
    },
    'what was Astra involvement in the Hugging Face incident',
    2,
  );
  expect(visited).toContain('https://safety.example.com/gpt-6-astra');
  expect(state.evidence).toBe('direct');
  expect(state.results[0].quote).toContain('Hugging Face incident');
});
it('still fetches a working related host after the source origin blocks public pages', async () => {
  const siblings = Array.from({ length: 8 }, (_, i) => `/index/astra-note-${i}`);
  const html = [
    ...siblings.map((path) => `<a href="${path}">Astra notes</a>`),
    '<a href="https://safety.example.com/gpt-6-astra">Astra system card</a>',
  ].join('');
  const pages: Record<string, { body?: string; status?: number }> = {
    'https://safety.example.com/gpt-6-astra': { body: `<p>${quote}</p>` },
  };
  for (const path of siblings) pages[`https://news.example.com${path}`] = { status: 403 };
  const { state, visited } = await runHosts(
    html,
    pages,
    {
      ...abstainingRouter,
      async select(_q, candidates, _s, _b, purpose) {
        const candidate =
          purpose !== 'route'
            ? candidates.find((c) => c.text?.includes('Hugging Face incident'))
            : undefined;
        return { mode: 'jev', candidate, verified: !!candidate, support: candidate ? 0.9 : 0 };
      },
    },
    'what was Astra involvement in the Hugging Face incident',
    3,
  );
  expect(visited.filter((url) => url.startsWith('https://news.example.com/') && !url.endsWith('/robots.txt')).length).toBeLessThan(6);
  expect(visited).toContain('https://safety.example.com/gpt-6-astra');
  expect(state.evidence).toBe('direct');
});

import { it, expect, afterAll, beforeAll } from 'vitest';
import { createServer } from '../../apps/api/src/server';
import { MockProvider, type Provider } from '../../packages/jev/src';
import { extractHtml } from '../../packages/extraction/src/html';
import { fixtureServer } from '../../packages/fixtures/src/server';
import { SafeFetcher } from '../../apps/api/src/fetch/safe-fetch';
import { publicNetworkPolicy, type NetworkPolicy } from '../../packages/security/src/network';
import { actionPolicy } from '../../packages/security/src';
import { defaultLimits, SearchSession } from '../../apps/api/src/search/engine';
import { PublicCache } from '../../apps/api/src/cache/public-cache';
import type { SearchState } from '../../packages/contracts/src';
const token = 'test-client-token-with-more-than-24-characters';
const second = 'second-client-token-with-more-than-24-characters';
const headers = { authorization: `Bearer ${token}` };
const fixtures = await fixtureServer();
let origin: string;
let policy: NetworkPolicy;
const provider = new MockProvider();
let api: Awaited<ReturnType<typeof createServer>>;
beforeAll(async () => {
  origin = await fixtures.listen({ host: '127.0.0.1', port: 0 });
  policy = {
    async validate(url, scope) {
      if (url.origin !== origin || scope !== origin || actionPolicy(url.href) !== 'read_candidate')
        throw new Error('test_policy_blocked');
      return { address: '127.0.0.1', family: 4 };
    },
  };
  api = await createServer({
    tokens: [token, second],
    provider,
    policy,
    limits: { ...defaultLimits, deadlineMs: 5000 },
  });
});
afterAll(async () => {
  await api.close();
  await fixtures.close();
});
async function search(path: string, question: string, scope: 'page' | 'site' = 'page') {
  const html = await fixtures.inject(path);
  const snapshot = extractHtml(html.body, origin + path);
  snapshot.private = true;
  snapshot.candidates = snapshot.candidates.map((c) => ({ ...c, provenance: 'live_dom' }));
  const response = await api.inject({
    method: 'POST',
    url: '/v1/searches',
    headers,
    payload: {
      protocol: 1,
      question,
      scope,
      snapshot,
      consent: true,
      publicSearchConsent: scope === 'site',
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<SearchState>();
}
async function finish(id: string) {
  for (let i = 0; i < 200; i++) {
    const r = await api.inject({ method: 'GET', url: `/v1/searches/${id}`, headers });
    const s = r.json<SearchState>();
    if (s.lifecycle !== 'running') return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
}
it('requires authentication before parsing or scheduling work', async () => {
  const r = await api.inject({ method: 'POST', url: '/v1/searches', payload: {} });
  expect(r.statusCode).toBe(401);
});
it('finds the requested detail on the current page', async () => {
  const initial = await search('/fixtures/journal', 'Which beacon is marked amber?');
  const s = await finish(initial.id);
  expect(s.evidence).toBe('direct');
  expect(s.results[0].quote).toContain('marked amber');
  expect(s.coverage.pagesChecked).toBe(1);
});
it('finds a handbook subpage without fetching actions', async () => {
  await fixtures.inject({ method: 'POST', url: '/__reset' });
  const initial = await search('/fixtures/docs', 'How does a cycle repeat?', 'site');
  const s = await finish(initial.id);
  expect(s.evidence).toBe('direct');
  expect(s.results[0].url).toContain('/processes');
  expect(s.results[0].quote).toContain('fixed cycle');
  const stats = (await fixtures.inject('/__stats')).json();
  expect(stats.actions).toBe(0);
  expect(stats.requests).not.toContain('/logout');
});
it('does not force an answer for unrelated questions', async () => {
  const s = await finish((await search('/fixtures/journal', 'Which instrument measures rainfall?')).id);
  expect(s.evidence).toBe('none');
  expect(s.message).toBe('No answer found in the pages checked.');
});
it('does not expose another owner session or accept updates', async () => {
  const s = await search('/fixtures/journal', 'beacon color');
  for (const method of ['GET', 'POST'] as const) {
    const r = await api.inject({
      method,
      url: `/v1/searches/${s.id}${method === 'POST' ? '/cancel' : ''}`,
      headers: { authorization: `Bearer ${second}` },
    });
    expect(r.statusCode).toBe(404);
  }
});
it('cancels idempotently and deletes isolated results', async () => {
  const s = await search('/fixtures/docs', 'unknown question', 'site');
  const cancelled = await api.inject({
    method: 'POST',
    url: `/v1/searches/${s.id}/cancel`,
    headers,
  });
  expect(cancelled.json().lifecycle).toBe('cancelled');
  expect(
    (await api.inject({ method: 'POST', url: `/v1/searches/${s.id}/cancel`, headers })).statusCode,
  ).toBe(200);
  await api.inject({ method: 'DELETE', url: `/v1/searches/${s.id}`, headers });
  expect(
    (await api.inject({ method: 'GET', url: `/v1/searches/${s.id}`, headers })).statusCode,
  ).toBe(404);
});
it('blocks redirect network effects before accessing a new origin', async () => {
  const fetcher = new SafeFetcher(policy);
  await expect(
    fetcher.get(origin + '/fixtures/redirect', origin, new AbortController().signal),
  ).rejects.toThrow('test_policy_blocked');
});
it('refuses fixture network access under production policy', async () => {
  const fetcher = new SafeFetcher(publicNetworkPolicy);
  await expect(
    fetcher.get(origin + '/fixtures/docs', origin, new AbortController().signal),
  ).rejects.toThrow();
});
it('untrusted injected text cannot schedule action URLs', async () => {
  await fixtures.inject({ method: 'POST', url: '/__reset' });
  const s = await finish(
    (await search('/fixtures/injected', 'Where can I find a telescope?', 'site')).id,
  );
  expect(s.results).toHaveLength(0);
  const stats = (await fixtures.inject('/__stats')).json();
  expect(stats.actions).toBe(0);
  expect(stats.requests.some((p: string) => p.includes('meta-data'))).toBe(false);
});

it('rate-limited searches stop without emitting unverified results or repeating calls', async () => {
  let calls = 0;
  const limited = await createServer({
    tokens: [token],
    policy,
    provider: {
      mode: 'jev',
      transport: 'gateway',
      async select() {
        calls++;
        throw Object.assign(new Error('provider throttled'), { statusCode: 429 });
      },
    },
  });
  try {
    const snapshot = extractHtml(
      (await fixtures.inject('/fixtures/docs')).body,
      origin + '/fixtures/docs',
    );
    const response = await limited.inject({
      method: 'POST',
      url: '/v1/searches',
      headers,
      payload: {
        protocol: 1,
        question: 'How does a cycle repeat?',
        scope: 'site',
        snapshot,
        consent: true,
        publicSearchConsent: true,
        refresh: false,
      },
    });
    expect(response.statusCode).toBe(201);
    let state = response.json<SearchState>();
    for (let i = 0; i < 200 && state.lifecycle === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = (
        await limited.inject({ url: `/v1/searches/${state.id}`, headers })
      ).json<SearchState>();
    }
    expect(state.lifecycle).not.toBe('running');
    expect(state.provider).toBe('jev');
    expect(state.lifecycle).toBe('failed');
    expect(state.coverage.stopReason).toBe('provider_rate_limited');
    expect(state.coverage.limitations).toContain('provider_rate_limited');
    expect(state.results).toHaveLength(0);
    expect(calls).toBe(1);
  } finally {
    await limited.close();
  }
});

async function verifySearch(provider: Provider) {
  const snapshot = extractHtml(
    (await fixtures.inject('/fixtures/docs')).body,
    origin + '/fixtures/docs',
  );
  const cache = new PublicCache();
  const session = new SearchSession(
    'owner',
    {
      protocol: 1,
      question: 'How does a cycle repeat?',
      scope: 'site',
      snapshot,
      consent: true,
      publicSearchConsent: true,
      refresh: true,
    },
    provider,
    new SafeFetcher(policy),
    cache,
  );
  try {
    await session.run();
    return session.state;
  } finally {
    cache.close();
  }
}
it('rejects partial validation but continues discovery when Jev abstains from routing', async () => {
  let routes = 0;
  const state = await verifySearch({
    mode: 'jev',
    async select(_q, candidates, _signal, _budget, purpose) {
      if (purpose === 'route') {
        routes++;
        return { mode: 'jev', support: 0 };
      }
      return { mode: 'jev', support: 0.7, candidate: candidates[0] };
    },
  });
  expect(state.results).toHaveLength(0);
  expect(state.coverage.pagesChecked).toBeGreaterThan(1);
  expect(state.provider).toBe('jev');
  expect(routes).toBeGreaterThan(0);
});
it('displays a fetched destination only after destination verification passes', async () => {
  const purposes: string[] = [];
  const state = await verifySearch({
    mode: 'jev',
    async select(_q, candidates, _signal, _budget, purpose) {
      purposes.push(purpose || 'evidence');
      if (purpose === 'route')
        return {
          mode: 'jev',
          support: 0.6,
          candidate: candidates.find((c) => c.safeUrl?.includes('/processes')),
        };
      if (purpose === 'destination')
        return {
          mode: 'jev',
          support: 0.96,
          candidate: candidates.find((c) => c.text?.includes('A fixed cycle')),
        };
      return { mode: 'jev', support: 0 };
    },
  });
  expect(purposes).toEqual(['evidence', 'route', 'destination']);
  expect(state.results).toHaveLength(1);
  expect(state.results[0]).toMatchObject({
    kind: 'page',
    local: false,
    provider: 'jev',
    evidence: 'direct',
  });
  expect(state.results[0].url).toContain('/processes');
});
it('propagates route verification errors instead of treating them as fetch errors', async () => {
  const state = await verifySearch({
    mode: 'jev',
    async select(_q, _c, _s, _b, purpose) {
      if (purpose === 'route') throw new DOMException('request timed out', 'TimeoutError');
      return { mode: 'jev', support: 0 };
    },
  });
  expect(state.lifecycle).toBe('failed');
  expect(state.coverage.stopReason).toBe('provider_timeout');
  expect(state.results).toHaveLength(0);
  expect(state.message).toContain('timed out');
});

it('respects the separate Jev verdict rather than imposing a probability cutoff', async () => {
  for (const verified of [true, false]) {
    const state = await verifySearch({
      mode: 'jev',
      async select(_q, candidates, _s, _b, purpose) {
        return purpose === 'evidence'
          ? { mode: 'jev', candidate: candidates[0], verified, support: verified ? 0.7 : 0.99 }
          : { mode: 'jev', support: 0 };
      },
    });
    expect(state.results.length).toBe(verified ? 1 : 0);
  }
});

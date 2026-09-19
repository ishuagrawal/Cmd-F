import { writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fixtureServer } from '../packages/fixtures/src/server';
import { fixturePolicy } from '../tests/helpers/fixture-policy';
import { createServer } from '../apps/api/src/server';
import { MockProvider } from '../packages/jev/src';
import { extractHtml } from '../packages/extraction/src/html';
import { StateSchema } from '../packages/contracts/src';
const fixtures = await fixtureServer();
await fixtures.listen({ host: '127.0.0.1', port: 4318 });
const token = 'benchmark-token-not-a-production-secret';
const api = await createServer({
  tokens: [token],
  provider: new MockProvider(),
  policy: fixturePolicy,
});
const origin = await api.listen({ host: '127.0.0.1', port: 0 });
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const samples: Record<string, number[]> = { current: [], site: [] };
const counts: Record<string, number[]> = { current: [], site: [] };
try {
  for (const mode of ['current', 'site'])
    for (let i = 0; i < 20; i++) {
      const path = mode === 'current' ? '/fixtures/news' : '/fixtures/docs';
      const snapshot = extractHtml(
        (await fixtures.inject(path)).body,
        'http://127.0.0.1:4318' + path,
      );
      const start = performance.now();
      const response = await fetch(origin + '/v1/searches', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          protocol: 1,
          question:
            mode === 'current' ? "What is the baby's name?" : 'How do loops work in Python?',
          scope: mode === 'current' ? 'page' : 'site',
          snapshot,
          consent: true,
          publicSearchConsent: mode === 'site',
          refresh: true,
        }),
      });
      if (!response.ok) throw new Error('benchmark creation failed');
      let state = StateSchema.parse(await response.json());
      while (state.lifecycle === 'running') {
        await new Promise((r) => setTimeout(r, 5));
        state = StateSchema.parse(
          await (await fetch(`${origin}/v1/searches/${state.id}`, { headers })).json(),
        );
      }
      if (state.evidence !== 'direct') throw new Error('benchmark search failed');
      samples[mode].push(performance.now() - start);
      counts[mode].push(state.coverage.pagesChecked);
      await fetch(`${origin}/v1/searches/${state.id}`, { method: 'DELETE', headers });
    }
  const metrics = Object.fromEntries(
    Object.entries(samples).map(([key, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return [
        key,
        {
          n: sorted.length,
          p50Ms: sorted[Math.floor(sorted.length * 0.5)],
          p95Ms: sorted[Math.floor(sorted.length * 0.95)],
          pagesChecked: counts[key],
        },
      ];
    }),
  );
  const report = {
    generatedAt: new Date().toISOString(),
    provider: 'mock',
    note: 'Local API HTTP roundtrip including orchestration and anonymous fixture fetch; prebuilt snapshots, no browser extraction/rendering, no real internet or Jev latency; forced fresh fetches. Not a full user-perceived performance claim.',
    metrics,
    samples,
    actionTraps: (await fixtures.inject('/__stats')).json().actions,
  };
  await mkdir('docs/reports', { recursive: true });
  await writeFile('docs/reports/latency-mock.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.metrics, null, 2));
} finally {
  await api.close();
  await fixtures.close();
}

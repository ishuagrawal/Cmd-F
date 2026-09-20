import './load-env';
import { writeFile, readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { providerFromEnv } from '../packages/jev/src';
import { SearchSession, defaultLimits } from '../apps/api/src/search/engine';
import { SafeFetcher } from '../apps/api/src/fetch/safe-fetch';
import { publicNetworkPolicy } from '../packages/security/src/network';
import { PublicCache } from '../apps/api/src/cache/public-cache';
import { extractHtml } from '../packages/extraction/src/html';
import type { PageSnapshot } from '../packages/contracts/src';
const provider = providerFromEnv({ ...process.env, PROVIDER_MODE: 'live' });
const rows: unknown[] = [];
const jobs =
  '<title>Careers</title><h1>Open roles</h1>' +
  [
    ['backend', 'Backend Software Engineer — Codex'],
    ['systems', 'AI Systems Engineer, Codex Agents'],
    ['applied', 'Applied AI Engineer, Codex'],
    ['product', 'Product Manager — Codex'],
    ['sales', 'Account Executive'],
    ['infra', 'Infrastructure Engineer — ChatGPT'],
  ]
    .map(([id, label]) => `<a href="https://jobs.example.com/${id}">${label}</a>`)
    .join('');
const cases: {
  name: string;
  question: string;
  snapshot: PageSnapshot;
  expected: RegExp;
  absent?: boolean;
  scope?: 'site' | 'page';
}[] = [
  {
    name: 'semantic-job-list',
    question: 'software engineering roles codex',
    snapshot: extractHtml(jobs, 'https://example.com/careers'),
    expected: /engineer/i,
  },
  {
    name: 'missing-salary',
    question: 'What is the salary for Codex engineering roles?',
    snapshot: extractHtml(jobs, 'https://example.com/careers'),
    expected: /./,
    absent: true,
  },
  {
    name: 'semantic-no-overlap',
    question: 'Where can I get my money back?',
    snapshot: extractHtml(
      '<p>Welcome to our shop.</p><a href="/returns">Returns and reimbursements</a>',
      'https://example.com/help',
    ),
    expected: /reimbursements/i,
  },
  {
    name: 'false-positive',
    question: 'Which instrument measures rainfall?',
    snapshot: extractHtml(jobs, 'https://example.com/careers'),
    expected: /./,
    absent: true,
  },
];
if (process.argv.includes('--sites')) {
  const snapshot = JSON.parse(await readFile('.local/w3-snapshot.json', 'utf8'));
  const page = snapshot.candidates ? snapshot : snapshot.snapshot;
  if (page?.candidates)
    for (const question of ['how do sets work', 'how do lists work', 'how do you create a set'])
      cases.push({
        name: `w3-${question}`,
        question,
        snapshot: page,
        expected: /set|list|collection|item/i,
        scope: 'site',
      });
}
if (process.argv.includes('--wiki')) {
  const entries: { query: string; snapshot: PageSnapshot }[] = JSON.parse(
    await readFile('.local/wiki-snapshots.json', 'utf8'),
  );
  for (const entry of entries)
    cases.push({
      name: `wiki-${entry.query}`,
      question: entry.query,
      snapshot: entry.snapshot,
      expected: /attack|Microsoft|testif|Senate|fire|candid/i,
    });
}
if (process.argv.includes('--large')) {
  cases.push({
    name: 'late-semantic-catalog-818',
    question: 'Where can I get my money back?',
    snapshot: extractHtml(
      Array.from(
        { length: 818 },
        (_, i) =>
          `<a href="/topic/${i}">${i === 817 ? 'Returns and reimbursements' : 'Catalog entry ' + i}</a>`,
      ).join(''),
      'https://example.com/catalog',
    ),
    expected: /reimbursements/,
  });
}
const cache = new PublicCache();
try {
  for (const c of cases) {
    c.snapshot.candidates.forEach((x) => (x.provenance = 'live_dom'));
    const session = new SearchSession(
      'regression',
      {
        protocol: 1,
        question: c.question,
        scope: c.scope || 'page',
        snapshot: c.snapshot,
        consent: true,
        publicSearchConsent: c.scope === 'site',
        refresh: true,
      },
      provider,
      new SafeFetcher(publicNetworkPolicy),
      cache,
      defaultLimits,
    );
    const started = performance.now();
    await session.run();
    const quotes = session.state.results.map((r) => r.quote);
    const pass =
      session.state.lifecycle === 'completed' &&
      (c.absent ? quotes.length === 0 : quotes.some((q) => c.expected.test(q)));
    const row = {
      name: c.name,
      question: c.question,
      pass,
      ms: Math.round(performance.now() - started),
      quotes,
      coverage: session.state.coverage,
      message: session.state.message,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  if (rows.some((row) => !(row as { pass: boolean }).pass)) process.exitCode = 1;
  await writeFile(
    '.local/search-pipeline-live' + (process.argv.includes('--large') ? '-large' : '') + '.json',
    JSON.stringify(rows, null, 2),
  );
} finally {
  cache.close();
}

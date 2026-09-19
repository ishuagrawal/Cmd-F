import './load-env';
import { publicNetworkPolicy } from '../packages/security/src/network';
import { writeFile } from 'node:fs/promises';
import { providerFromEnv } from '../packages/jev/src';
import { extractHtml } from '../packages/extraction/src/html';
import { SearchSession } from '../apps/api/src/search/engine';
import { SafeFetcher } from '../apps/api/src/fetch/safe-fetch';
import { PublicCache } from '../apps/api/src/cache/public-cache';
const provider = providerFromEnv({ ...process.env, PROVIDER_MODE: 'live' });
const fetcher = new SafeFetcher(publicNetworkPolicy);
const startUrl = 'https://www.w3schools.com/python/python_json.asp';
const cases = [
  {
    url: startUrl,
    question: 'how to add elements to a set',
    scope: 'site' as const,
    path: '/python/python_sets_add.asp',
    quote: /add\(\)|update\(\)/,
  },
  {
    url: startUrl,
    question: 'set',
    scope: 'site' as const,
    path: '/python/python_sets.asp',
    quote: /set/i,
  },
  {
    url: startUrl,
    question: 'how do lists work',
    scope: 'site' as const,
    path: '/python/python_lists.asp',
    quote: /list/i,
  },
  {
    url: startUrl,
    question: 'convert a Python object to JSON',
    scope: 'page' as const,
    path: undefined,
    quote: /dumps/,
  },
  {
    url: 'https://docs.python.org/3/tutorial/index.html',
    question: 'how do I handle exceptions',
    scope: 'site' as const,
    path: '/3/tutorial/errors.html',
    quote: /except|try/,
  },
];
const cache = new PublicCache();
const rows = [];
try {
  for (const test of cases) {
    const { url, question, scope } = test;
    const page = await fetcher.get(url, new URL(url).origin, AbortSignal.timeout(10000));
    const snapshot = extractHtml(page.body, url, question);
    const session = new SearchSession(
      'diagnostic',
      {
        protocol: 1,
        question,
        scope,
        snapshot,
        consent: true,
        publicSearchConsent: true,
        refresh: true,
      },
      provider,
      fetcher,
      cache,
    );
    await session.run();
    const result = session.state.results[0];
    const passed =
      !!result &&
      test.quote.test(result.quote) &&
      (!test.path || new URL(result.url!).pathname === test.path);
    const row = { question, passed, ...session.state };
    if (!passed) process.exitCode = 1;
    rows.push(row);
    console.log(
      JSON.stringify({
        question,
        passed,
        source: result?.url || url,
        quote: result?.quote,
        coverage: session.state.coverage,
      }),
    );
  }
  await writeFile(
    'docs/reports/site-search-live.json',
    JSON.stringify(
      { generatedAt: new Date().toISOString(), transport: provider.transport, rows },
      null,
      2,
    ) + '\n',
  );
} finally {
  cache.close();
}

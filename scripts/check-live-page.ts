import './load-env';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { providerFromEnv } from '../packages/jev/src';
import { SearchSession } from '../apps/api/src/search/engine';
import { SafeFetcher } from '../apps/api/src/fetch/safe-fetch';
import { publicNetworkPolicy } from '../packages/security/src/network';
import { PublicCache } from '../apps/api/src/cache/public-cache';
import type { PageSnapshot } from '../packages/contracts/src';
const url = process.argv[2] || 'https://openai.com/careers/search/';
const question = process.argv[3] || 'software engineering roles codex';
const scope = process.argv.includes('--site') ? 'site' : 'page';
const built = await build({
  stdin: {
    contents:
      "import {DomSession} from './packages/extraction/src/dom'; globalThis.TestSession=DomSession;",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
});
const browser = await chromium.launch({ headless: true });
const cache = new PublicCache();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.addScriptTag({ content: built.outputFiles[0].text });
  const snapshot = await page.evaluate((q) => {
    const w = window as unknown as {
      TestSession: new (doc: Document) => { inspect(q: string): PageSnapshot };
      testSession: { inspect(q: string): PageSnapshot };
    };
    w.testSession = new w.TestSession(document);
    return w.testSession.inspect(q);
  }, question);
  await writeFile('.local/live-page-snapshot.json', JSON.stringify(snapshot, null, 2));
  const session = new SearchSession(
    'live-browser',
    {
      protocol: 1,
      question,
      scope,
      snapshot,
      consent: true,
      publicSearchConsent: scope === 'site',
      refresh: true,
    },
    providerFromEnv({ ...process.env, PROVIDER_MODE: 'live' }),
    new SafeFetcher(publicNetworkPolicy),
    cache,
  );
  const started = Date.now();
  session.listeners.add((e) => {
    if (e.type === 'result_updated')
      console.log(
        JSON.stringify({
          firstMatchMs: Date.now() - started,
          quotes: e.state.results.map((r) => r.quote),
        }),
      );
  });
  await session.run();
  while (session.state.lifecycle === 'waiting_for_user') {
    const next = await page.evaluate(
      ({ snapshotId, ids }) =>
        (
          window as unknown as {
            testSession: { readSections(id: string, ids: string[]): PageSnapshot };
          }
        ).testSession.readSections(snapshotId, ids),
      { snapshotId: snapshot.id, ids: session.state.requestedSections },
    );
    const finished = new Promise<void>((resolve) => {
      const listener = () => {
        if (session.state.lifecycle !== 'running') {
          session.listeners.delete(listener);
          resolve();
        }
      };
      session.listeners.add(listener);
    });
    await session.resume(next);
    await finished;
  }
  console.log(
    JSON.stringify({
      url: page.url(),
      title: snapshot.title,
      discovery: snapshot.discovery,
      ms: Date.now() - started,
      state: session.state,
    }),
  );
  await writeFile('.local/live-page-search.json', JSON.stringify(session.state, null, 2));
} finally {
  await browser.close();
  cache.close();
}

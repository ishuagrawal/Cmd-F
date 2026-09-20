import './load-env';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { SearchSession } from '../apps/api/src/search/engine';
import { PublicCache } from '../apps/api/src/cache/public-cache';
import { SafeFetcher } from '../apps/api/src/fetch/safe-fetch';
import { publicNetworkPolicy } from '../packages/security/src/network';
import { MockProvider, providerFromEnv } from '../packages/jev/src';

const live = process.argv.includes('--live');
const provider = live ? providerFromEnv() : new MockProvider();
const browser = await chromium.launch({ headless: true });
const cache = new PublicCache();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  let session: SearchSession;
  await page.route('http://127.0.0.1:4317/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let result: unknown = {};
    if (path === '/v1/config') result = { provider: provider.mode };
    else if (path === '/v1/searches') {
      const request = route.request().postDataJSON();
      if (request.scope !== 'page') throw new Error('This fixture must remain page-scoped');
      session = new SearchSession(
        'ui-test',
        request,
        provider,
        new SafeFetcher(publicNetworkPolicy),
        cache,
      );
      await session.run();
      result = session.state;
    } else if (path.endsWith('/events')) {
      await route.fulfill({
        contentType: 'text/event-stream',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: session.events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
      body: JSON.stringify(result),
    });
  });
  await page.route('https://fixture.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/__dev/config') {
      await route.fulfill({ json: { token: 'isolated-test-token' } });
      return;
    }
    if (path.startsWith('/fixtures/')) {
      await route.fulfill({
        contentType: 'text/html',
        body: '<main><h1>Careers</h1><a href="/jobs/software">Backend Software Engineer — Codex</a><a href="/jobs/ai">AI Systems Engineer, Codex Agents</a><a href="/jobs/applied">Applied AI Engineer, Codex</a><a href="/jobs/product">Product Manager — Codex</a><p>The beacon is marked amber.</p></main>',
      });
      return;
    }
    const file = path === '/' ? '/overlay.html' : path;
    await route.fulfill({
      body: await readFile('apps/extension/dist' + file),
      contentType: file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/html',
    });
  });
  await page.goto('https://fixture.test/overlay.html');
  await expect(
    page.frameLocator('#fixture').getByRole('heading', { name: 'Careers' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Connection settings' }).click();
  await page.getByLabel('Search scope').selectOption('page');
  await page.getByRole('button', { name: 'Connection settings' }).click();
  await page
    .getByLabel('Your request')
    .fill(live ? 'software engineering roles codex' : 'software engineer');
  await expect(page.getByRole('button', { name: 'Send request' })).toBeEnabled();
  await page.getByLabel('Your request').press('Enter');
  await expect(page.locator('.source .eyebrow').first()).toHaveText('MATCHING LISTING');
  await expect(
    page.getByText('Destination details not verified.', { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open listing' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Show on page' }).first().click();
  await expect(page.frameLocator('#fixture').locator('[data-cmd-f=outline]')).toHaveCount(1);
  if (live) {
    await expect(page.locator('.source')).toHaveCount(3);
    await expect(page.locator('.source')).not.toContainText(['Product Manager']);
    await page.screenshot({ path: '.local/search-semantic-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.local/search-semantic-narrow.png' });
    await page.setViewportSize({ width: 1100, height: 850 });
  }
  await page
    .getByLabel('Your request')
    .fill(live ? 'What color is the beacon?' : 'Which beacon is marked amber?');
  await page.getByLabel('Your request').press('Enter');
  await expect(page.locator('.source blockquote')).toHaveText('The beacon is marked amber.');
  await expect(page.getByRole('button', { name: 'Open listing' })).toHaveCount(0);
  console.log(
    'PASS: built overlay shows unverified listing and actions, highlights source, then returns verified passage for factual query.',
  );
} finally {
  cache.close();
  await browser.close();
}

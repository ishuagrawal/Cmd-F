import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Worker,
  type Page,
} from '@playwright/test';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
let context: BrowserContext;
let worker: Worker;
let extensionId: string;
let site: Page;
let panel: Page;
const origin = 'http://127.0.0.1:4318';
test.beforeAll(async () => {
  const clientToken = (await readFile('.local/client-token', 'utf8')).trim();
  const config = await fetch('http://127.0.0.1:4317/v1/config', {
    headers: { authorization: `Bearer ${clientToken}` },
  }).then((r) => r.json());
  expect(
    config.provider,
    'Browser regression tests require a mock backend. Stop the live preview before running them.',
  ).toBe('mock');
  const ext = path.resolve('.local/test-extension');
  await mkdir(ext, { recursive: true });
  await cp('apps/extension/dist', ext, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(ext, 'manifest.json'), 'utf8'));
  manifest.name = 'Cmd-F fixture test';
  manifest.host_permissions.push(origin + '/*');
  await writeFile(path.join(ext, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    viewport: { width: 1280, height: 900 },
  });
  worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});
test.afterAll(async () => {
  await context?.close();
});
test.beforeEach(async () => {
  site = await context.newPage();
  panel = await context.newPage();
  await fetch(origin + '/__reset', { method: 'POST' });
});
test.afterEach(async () => {
  await panel.close();
  await site.close();
});
async function openFixture(name: string) {
  await site.goto(origin + '/fixtures/' + name);
  await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url });
    await chrome.storage.session.set({ sourceTabId: tabs[0].id });
  }, site.url());
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.locator('.site-line')).toContainText('127.0.0.1');
  await expect(panel.getByText('Demo provider', { exact: false })).toBeVisible();
  await expect(panel.getByLabel('Local client token')).toHaveCount(0);
}
async function query(question: string, scope: 'page' | 'site' = 'page') {
  await panel
    .getByRole('button', { name: scope === 'page' ? 'This page' : 'This site', exact: true })
    .click();
  await panel.getByLabel('What are you looking for?').fill(question);
  await panel.getByRole('button', { name: 'Find source', exact: true }).click();
  await expect(panel.getByRole('dialog')).toBeVisible();
  await panel.getByLabel('Share this page’s selected text for this search.').check();
  if (scope === 'site')
    await panel
      .getByLabel('Also check this site and relevant linked websites anonymously.')
      .check();
  await panel.getByRole('button', { name: 'Find the source', exact: true }).click();
}
async function zeroActions() {
  expect((await (await fetch(origin + '/__stats')).json()).actions).toBe(0);
}
test('real extension finds a handbook subpage without navigating the source tab', async () => {
  await openFixture('docs');
  const url = site.url();
  await query('How does a cycle repeat?', 'site');
  await expect(panel.locator('.result blockquote').first()).toContainText('fixed cycle');
  await expect(
    panel.getByRole('button', { name: 'Open source', exact: true }).first(),
  ).toBeVisible();
  expect(site.url()).toBe(url);
  await zeroActions();
  await panel.setViewportSize({ width: 390, height: 900 });
  await panel.screenshot({ path: 'docs/screenshots/extension-docs.png', fullPage: true });
});
test('article detail is quoted and reversibly highlighted without modifying text', async () => {
  await openFixture('journal');
  const before = await site.locator('main').innerText();
  await query('Which beacon is marked amber?');
  await expect(panel.locator('.result blockquote')).toContainText('amber');
  await panel.getByRole('button', { name: 'Show here' }).click();
  await expect(site.locator('[data-cmd-f=plate]')).toHaveCount(1);
  expect(await site.evaluate(() => CSS.highlights?.has('cmd-f-match') ?? false)).toBe(false);
  await expect(site.locator('[data-cmd-f=outline]')).toHaveCount(0);
  expect(await site.locator('main').innerText()).toBe(before);
  await panel.getByRole('button', { name: 'Clear highlight' }).click();
  expect(await site.evaluate(() => CSS.highlights?.has('cmd-f-match') ?? false)).toBe(false);
  await expect(site.locator('[data-cmd-f=plate]')).toHaveCount(0);
  await expect(site.locator('[data-cmd-f=outline]')).toHaveCount(0);
  await zeroActions();
});
test('private preview excludes values, drafts, and token URLs', async () => {
  await openFixture('settings');
  await panel.getByLabel('What are you looking for?').fill('change alerts');
  await panel.getByRole('button', { name: 'Find source', exact: true }).click();
  await expect(panel.getByRole('dialog')).toBeVisible();
  const preview = await panel.locator('.preview').textContent();
  expect(preview).not.toMatch(/hidden-value|hidden-secret|unsent private|one-time-action/);
  await expect(panel.getByRole('button', { name: 'Find the source', exact: true })).toBeDisabled();
  await zeroActions();
});
for (const fixture of ['settings', 'dynamic'])
  test(`finishes without manual menu inspection in ${fixture}`, async () => {
    await openFixture(fixture);
    await query('Where can I change the alert setting?');
    await expect(panel.locator('.empty-result')).toContainText('No answer found');
    await expect(panel.locator('.guidance')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /Inspect again/ })).toHaveCount(0);
    expect(await site.locator('#menu').getAttribute('aria-expanded')).toBe('false');
    await zeroActions();
    expect(site.url()).toBe(origin + '/fixtures/' + fixture);
  });
test('no answer is honest and action links receive zero requests', async () => {
  await openFixture('settings');
  await query('Which instrument measures rainfall?', 'site');
  await expect(panel.locator('.empty-result')).toContainText(
    'No answer found in the pages checked.',
  );
  await zeroActions();
  const stats = await (await fetch(origin + '/__stats')).json();
  expect(stats.requests).not.toContain('/logout');
  expect(stats.requests.some((p: string) => p.startsWith('/activate'))).toBe(false);
});
test('late-page source is found within bounded payload', async () => {
  await openFixture('long');
  await query('What phrase opens the visitor guide?');
  await expect(panel.locator('.result blockquote').first()).toContainText('quiet lantern');
  await panel.getByRole('button', { name: 'Show here' }).first().click();
  await expect(site.locator('[data-cmd-f=plate]')).toHaveCount(1);
  expect(await site.evaluate(() => CSS.highlights?.has('cmd-f-match') ?? false)).toBe(false);
  await expect(site.locator('[data-cmd-f=outline]')).toHaveCount(0);
});
test('changing source invalidates highlighting', async () => {
  await openFixture('duplicates');
  await query('When does the north garden gate open?');
  await expect(panel.locator('.result')).toHaveCount(1);
  await site.locator('#change').click();
  await panel.getByRole('button', { name: 'Show here' }).click();
  await expect(panel.getByRole('alert')).toContainText(/changed|again/);
  expect(await site.evaluate(() => CSS.highlights?.has('cmd-f-match') ?? false)).toBe(false);
  await expect(site.locator('[data-cmd-f=outline]')).toHaveCount(0);
});
test('same-origin frames and open shadow content are inspected; unsupported surfaces disclosed', async () => {
  await openFixture('surfaces');
  await query('When does the shadow library close?');
  await expect(panel.locator('.result blockquote').first()).toContainText('sunset');
  await panel.getByText('Search coverage', { exact: true }).click();
  await expect(panel.locator('.coverage')).toContainText('frame inaccessible');
  await expect(panel.locator('.coverage')).toContainText('canvas unsupported');
});
test('source tab navigation discards old local results', async () => {
  await openFixture('journal');
  await query('Which beacon is marked amber?');
  await expect(panel.locator('.result')).toHaveCount(1);
  await site.goto(origin + '/fixtures/docs');
  await expect(panel.locator('.result')).toHaveCount(0);
  await expect(panel.getByRole('alert')).toContainText('source page changed');
});
test('browser playground renders at desktop and mobile sizes', async () => {
  await panel.goto('http://127.0.0.1:5173/sidepanel.html');
  await expect(panel.locator('.intro h1')).toHaveText('Find what you mean.');
  await expect(panel.locator('.site-line')).toContainText('127.0.0.1');
  await expect(panel.locator('.mode-note')).toContainText('Demo provider');
  await panel.screenshot({ path: 'docs/screenshots/playground.png', fullPage: true });
  await panel.setViewportSize({ width: 390, height: 844 });
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: 'docs/screenshots/playground-mobile.png', fullPage: true });
  await query('How does a cycle repeat?', 'site');
  await expect(panel.locator('.result blockquote').first()).toContainText('fixed cycle');
});
test('source stays pinned across tab switches and a service-worker restart', async () => {
  await openFixture('journal');
  await query('Which beacon is marked amber?');
  await expect(panel.locator('.result')).toHaveCount(1);
  const other = await context.newPage();
  await other.goto(origin + '/fixtures/docs');
  const cdp = await context.newCDPSession(panel);
  const targets = await cdp.send('Target.getTargets');
  const background = targets.targetInfos.find(
    (t) => t.type === 'service_worker' && t.url.includes(extensionId),
  );
  expect(background).toBeTruthy();
  await cdp.send('Target.closeTarget', { targetId: background!.targetId });
  await panel.getByRole('button', { name: 'Show here' }).click();
  await expect(site.locator('[data-cmd-f=plate]')).toHaveCount(1);
  expect(await site.evaluate(() => CSS.highlights?.has('cmd-f-match') ?? false)).toBe(false);
  await expect(site.locator('[data-cmd-f=outline]')).toHaveCount(0);
  await expect(other.locator('[data-cmd-f=outline]')).toHaveCount(0);
  await zeroActions();
  await other.close();
  await cdp.detach();
});
test('an action-like anchor is highlight-only and never opened or fetched', async () => {
  await openFixture('action-link');
  await query('Where can I change the alert setting?', 'site');
  await expect(panel.locator('.result blockquote')).toHaveText('Change alerts');
  await expect(panel.getByRole('button', { name: 'Open source', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Show here' }).click();
  await expect(site.locator('[data-cmd-f=outline]')).toHaveCount(1);
  await zeroActions();
});

test('consent discloses TypeSafe before any page text is submitted', async () => {
  await panel.route('**/v1/config', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'jev', transport: 'typesafe', renderer: false }),
    }),
  );
  let searches = 0;
  await panel.route('**/v1/searches', async (route) => {
    searches++;
    await route.abort();
  });
  await openFixture('journal');
  await panel.getByLabel('What are you looking for?').fill('Which beacon is marked amber?');
  await panel.getByRole('button', { name: 'Find source', exact: true }).click();
  await expect(panel.getByRole('dialog')).toContainText('TypeSafe/Jev');
  await expect(panel.getByRole('dialog')).not.toContainText('Vercel');
  await expect(panel.getByRole('button', { name: 'Find the source', exact: true })).toBeDisabled();
  expect(searches).toBe(0);
});

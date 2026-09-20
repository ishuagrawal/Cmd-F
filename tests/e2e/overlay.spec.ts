import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Worker,
  type Page,
  type Locator,
} from '@playwright/test';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
let context: BrowserContext;
let worker: Worker;
let site: Page;
let chat: Locator;
let extensionId: string;
const origin = 'http://127.0.0.1:4318';
test.beforeAll(async () => {
  const token = (await readFile('.local/client-token', 'utf8')).trim();
  const config = await fetch('http://127.0.0.1:4317/v1/config', {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  expect(config.provider, 'Stop the live preview before regression tests.').toBe('mock');
  const dir = path.resolve('.local/overlay-test-extension');
  await mkdir(dir, { recursive: true });
  await cp('apps/extension/dist', dir, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push(origin + '/*');
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
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
});
test.afterEach(async () => {
  await site.close();
});
async function open(name = 'journal') {
  await site.goto(origin + '/fixtures/' + name);
  // Same injected entrypoint as the action/keyboard command. OS hotkey dispatch is a manual gate.
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      files: ['overlay-host.js'],
    });
  }, site.url());
  chat = site.locator('[data-cmd-f=overlay]');
  await expect(chat.getByLabel('Your request')).toBeVisible();
  await chat.getByLabel('Your request').fill('hi');
  await expect(chat.getByRole('button', { name: 'Send request' })).toBeEnabled();
  await chat.getByLabel('Your request').fill('');
  await expect(chat.getByRole('button', { name: 'Connection settings' })).toBeVisible();
  await expect(chat.getByRole('heading', { name: 'Connect to the local backend' })).toHaveCount(0);
}
async function ask(question: string, scope: 'site' | 'page' = 'site') {
  if (scope === 'page') {
    await chat.getByRole('button', { name: 'Connection settings' }).click();
    await chat.getByLabel('Search scope').selectOption('page');
    await chat.getByRole('button', { name: 'Connection settings' }).click();
  }
  await chat.getByLabel('Your request').fill(question);
  await expect(chat.getByRole('button', { name: 'Send request' })).toBeEnabled();
  await chat.getByLabel('Your request').press('Enter');
}
test('keeps overlay typing out of the page search', async () => {
  await open();
  await site.evaluate(() => {
    const keys: string[] = [];
    (window as Window & { __cmdFPageKeys?: string[] }).__cmdFPageKeys = keys;
    document.addEventListener('keydown', (e) => {
      keys.push(e.key);
    });
    const input = document.createElement('input');
    input.setAttribute('aria-label', 'Page search');
    document.body.prepend(input);
    document.addEventListener('keydown', (e) => {
      if (e.target === input) return;
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        input.focus();
        input.value += e.key;
        e.preventDefault();
      }
    });
  });
  await chat.getByLabel('Your request').click();
  await chat.getByLabel('Your request').pressSequentially('abc');
  expect(
    await site.evaluate(() => (window as Window & { __cmdFPageKeys?: string[] }).__cmdFPageKeys),
  ).toEqual([]);
  await expect(chat.getByLabel('Your request')).toHaveValue('abc');
  await expect(site.getByLabel('Page search')).toHaveValue('');
});
test('does not steal typing from the page after connecting', async () => {
  await context.route('**/v1/config', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });
  try {
    await site.goto(origin + '/fixtures/journal');
    await site.evaluate(() => {
      const input = document.createElement('input');
      input.setAttribute('aria-label', 'Page search');
      document.body.prepend(input);
    });
    await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id! },
        files: ['overlay-host.js'],
      });
    }, site.url());
    chat = site.locator('[data-cmd-f=overlay]');
    await expect(chat.getByLabel('Your request')).toBeVisible();
    const pageSearch = site.getByLabel('Page search');
    await pageSearch.click();
    await pageSearch.pressSequentially('github query', { delay: 80 });
    await expect(pageSearch).toHaveValue('github query');
    await expect(pageSearch).toBeFocused();
    await expect(chat.getByLabel('Your request')).toHaveValue('');
  } finally {
    await context.unroute('**/v1/config');
  }
});
test('registers the shortcut and opens a small pill without extracting its own UI', async () => {
  const commands = await worker.evaluate(() => chrome.commands.getAll());
  expect(commands.some((c) => c.name === '_execute_action' && c.shortcut)).toBe(true);
  await open();
  await expect(chat.locator('.conversation')).toBeHidden();
  const bounds = await site.locator('[data-cmd-f=overlay]').boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(440);
  expect(bounds!.height).toBeLessThan(70);
  expect(bounds!.x).toBeGreaterThan(800);
  await site.screenshot({ path: 'docs/screenshots/overlay-pill.png', animations: 'disabled' });
  await ask('Which beacon is marked amber?', 'page');
  await expect(chat.locator('blockquote')).toContainText('amber');
  await expect(chat.getByRole('button', { name: 'Open source' })).toHaveCount(0);
  await chat.getByRole('button', { name: 'Show on page' }).click();
  expect(await site.evaluate(() => CSS.highlights?.has('cmd-f-match') ?? false)).toBe(true);
  await expect(site.locator('[data-cmd-f=outline]')).toHaveCount(0);
  await expect(site.locator('[data-cmd-f=overlay]')).toHaveCount(1);
  await site.screenshot({ path: 'docs/screenshots/overlay-result.png' });
  await chat.getByLabel('Your request').press('Escape');
  await expect(site.locator('[data-cmd-f=overlay]')).toHaveCount(0);
});
test('Show on page tolerates unrelated mutations and repeated highlighting', async () => {
  await open();
  await ask('Which beacon is marked amber?', 'page');
  await expect(chat.locator('blockquote')).toContainText('amber');
  await chat.getByRole('button', { name: 'Show on page' }).click();
  await site.evaluate(() => {
    document.body.classList.add('layout-updated');
    document.querySelector('footer')!.textContent = 'Updated just now';
    const passage = [...document.querySelectorAll('p')].find((p) =>
      p.textContent?.includes('amber'),
    )!;
    passage.style.marginTop = '200px';
  });
  await chat.getByRole('button', { name: 'Show on page' }).click();
  expect(await site.evaluate(() => CSS.highlights?.has('cmd-f-match') ?? false)).toBe(true);
  await expect(site.locator('[data-cmd-f=outline]')).toHaveCount(0);
  await expect(chat.getByRole('alert')).toHaveCount(0);
});
test('Show on page recovers an exact passage after a website re-render', async () => {
  await open();
  await ask('Which beacon is marked amber?', 'page');
  await expect(chat.locator('blockquote')).toContainText('amber');
  await site.evaluate(() => {
    const passage = [...document.querySelectorAll('p')].find((p) =>
      p.textContent?.includes('amber'),
    )!;
    const replacement = passage.cloneNode(true) as HTMLElement;
    replacement.id = 'rerendered-passage';
    passage.replaceWith(replacement);
    replacement.style.marginTop = '600px';
  });
  await chat.getByRole('button', { name: 'Show on page' }).click();
  expect(await site.evaluate(() => CSS.highlights?.has('cmd-f-match') ?? false)).toBe(true);
  await expect(site.locator('[data-cmd-f=outline]')).toHaveCount(0);
  await expect(chat.getByRole('alert')).toHaveCount(0);
  const aligned = await site.evaluate(() => {
    const highlight = CSS.highlights.get('cmd-f-match');
    const range = highlight && ([...highlight][0] as Range);
    const target = document.getElementById('rerendered-passage');
    return !!(range && target && range.intersectsNode(target));
  });
  expect(aligned).toBe(true);
});
for (const change of ['changed-text', 'ambiguous-replacement', 'route-change'] as const) {
  test(`Show on page rejects ${change}`, async () => {
    await open();
    await ask('Which beacon is marked amber?', 'page');
    await expect(chat.locator('blockquote')).toContainText('amber');
    await site.evaluate((change) => {
      const passage = [...document.querySelectorAll('p')].find((p) =>
        p.textContent?.includes('amber'),
      )!;
      if (change === 'changed-text')
        passage.textContent = 'The original information was corrected.';
      else if (change === 'route-change') history.pushState({}, '', '/fixtures/another-article');
      else passage.replaceWith(passage.cloneNode(true), passage.cloneNode(true));
    }, change);
    await chat.getByRole('button', { name: 'Show on page' }).click();
    await expect(chat.getByRole('alert')).toContainText(/changed|again/);
    expect(await site.evaluate(() => CSS.highlights?.has('cmd-f-match') ?? false)).toBe(false);
    await expect(site.locator('[data-cmd-f=outline]')).toHaveCount(0);
  });
}
test('a disappearing duplicate never redirects the highlight to another occurrence', async () => {
  await open('duplicates');
  await ask('When does the north garden gate open?', 'page');
  await expect(chat.locator('blockquote')).toHaveCount(1);
  await site
    .locator('main p')
    .first()
    .evaluate((el) => el.remove());
  await chat.getByRole('button', { name: 'Show on page' }).click();
  await expect(chat.getByRole('alert')).toContainText('could not be located reliably');
  expect(await site.evaluate(() => CSS.highlights?.has('cmd-f-match') ?? false)).toBe(false);
  await expect(site.locator('[data-cmd-f=outline]')).toHaveCount(0);
});
test('a hidden result can be shown after it becomes visible without another search', async () => {
  await open();
  await ask('Which beacon is marked amber?', 'page');
  await expect(chat.locator('blockquote')).toContainText('amber');
  const passage = site.locator('main p').filter({ hasText: 'amber' });
  await passage.evaluate((el) => {
    (el as HTMLElement).hidden = true;
  });
  await chat.getByRole('button', { name: 'Show on page' }).click();
  await expect(chat.getByRole('alert')).toContainText('hidden or unavailable');
  await passage.evaluate((el) => {
    (el as HTMLElement).hidden = false;
  });
  await chat.getByRole('button', { name: 'Show on page' }).click();
  expect(await site.evaluate(() => CSS.highlights?.has('cmd-f-match') ?? false)).toBe(true);
  await expect(site.locator('[data-cmd-f=outline]')).toHaveCount(0);
  await expect(chat.getByRole('alert')).toHaveCount(0);
});
test('Send immediately searches the page and public site without a confirmation', async () => {
  const requests: { scope: string; consent: boolean; publicSearchConsent: boolean }[] = [];
  await context.route('**/v1/searches', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.continue();
  });
  try {
    await open('docs');
    await chat.getByLabel('Your request').fill('How does a cycle repeat?');
    expect(requests).toHaveLength(0);
    await chat.getByRole('button', { name: 'Send request' }).click();
    await expect(chat.locator('blockquote').first()).toContainText('fixed cycle');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ scope: 'site', consent: true, publicSearchConsent: true });
    await expect(chat.getByRole('heading', { name: 'Share this text to search?' })).toHaveCount(0);
    await expect(chat.getByRole('checkbox')).toHaveCount(0);
    await expect(chat.getByRole('button', { name: 'Search now' })).toHaveCount(0);
  } finally {
    await context.unroute('**/v1/searches');
  }
});
test('finds and highlights the article event instead of references despite an unrelated truncated block', async () => {
  await open('timeline');
  await ask('when was the report presented');
  await expect(chat.locator('blockquote')).toHaveText('The report was presented on May 16, 2023.');
  await expect(chat.getByRole('button', { name: 'Open source' })).toHaveCount(0);
  await chat.getByRole('button', { name: 'Show on page' }).click();
  const aligned = await site.evaluate(() => {
    const highlight = CSS.highlights.get('cmd-f-match');
    const range = highlight && ([...highlight][0] as Range);
    const target = document.getElementById('event');
    return !!(range && target && range.intersectsNode(target));
  });
  expect(aligned).toBe(true);
  await expect(site.locator('[data-cmd-f=outline]')).toHaveCount(0);
});
test('finds the fixed-cycle subpage beyond hundreds of unrelated navigation links', async () => {
  await open('reference-index');
  await ask('how do fixed cycles work');
  await expect(chat.locator('blockquote').first()).toContainText('each item in a sequence');
  await expect(chat.locator('.source h2').first()).toHaveText('Fixed cycles');
  await expect(chat.locator('.coverage')).toContainText('2 pages checked');
  await chat.getByText('Search details', { exact: true }).click();
  await expect(chat.locator('.page-details')).toContainText('verified');
  const opened = context.waitForEvent('page');
  await chat.getByRole('button', { name: 'Open source' }).first().click();
  const reference = await opened;
  await reference.waitForLoadState();
  expect(reference.url()).toContain('/fixtures/fixed-cycles');
  await reference.close();
});
test('finds a public subpage and opens the actual reference', async () => {
  await open('docs');
  const initial = site.url();
  await ask('How does a cycle repeat?');
  await expect(chat.locator('blockquote').first()).toContainText('fixed cycle');
  const next = context.waitForEvent('page');
  await chat.getByRole('button', { name: 'Open source' }).first().click();
  const reference = await next;
  await reference.waitForLoadState();
  expect(reference.url()).toContain('/fixtures/docs/processes');
  const fragment = new URL(reference.url()).hash.split(':~:text=')[1];
  expect(fragment).toBeTruthy();
  expect(decodeURIComponent(fragment)).toBe(
    (await chat.locator('blockquote').first().innerText()).replace(/\s+/g, ' ').trim(),
  );
  expect(site.url()).toBe(initial);
  await reference.close();
});
test('shows no-answer and connection failures inside the response panel', async () => {
  await open();
  await ask('Which instrument measures rainfall?', 'page');
  await expect(
    chat.getByText('No answer found in the pages checked.', { exact: false }),
  ).toBeVisible();
  await context.route('**/v1/searches', (route) => route.abort());
  await ask('Which beacon is marked amber?', 'page');
  await expect(chat.getByRole('alert')).toBeVisible();
  await context.unroute('**/v1/searches');
});
test('rejects cross-tab inspection from the overlay', async () => {
  await open();
  const other = await context.newPage();
  await other.goto(origin + '/fixtures/settings');
  const [tabId, otherId] = await worker.evaluate(
    async (urls: [string, string]) => {
      const [siteTab] = await chrome.tabs.query({ url: urls[0] });
      const [otherTab] = await chrome.tabs.query({ url: urls[1] });
      return [siteTab.id!, otherTab.id!];
    },
    [site.url(), other.url()] as [string, string],
  );
  const [{ result }] = await worker.evaluate(
    async ({ tabId, otherId }) =>
      chrome.scripting.executeScript({
        target: { tabId },
        func: (id) => chrome.runtime.sendMessage({ tabId: id, operation: { type: 'INSPECT' } }),
        args: [otherId],
      }),
    { tabId, otherId },
  );
  expect(result.error).toBeTruthy();
  await other.close();
});
test('stays within a narrow viewport and toggles without duplicate hosts', async () => {
  await site.setViewportSize({ width: 390, height: 700 });
  await open();
  const bounds = await site.locator('[data-cmd-f=overlay]').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      files: ['overlay-host.js'],
    });
  }, site.url());
  await expect(site.locator('[data-cmd-f=overlay]')).toHaveCount(0);
});

test('keeps progress below verified sources and hides unverified results', async () => {
  await open();
  const candidate = {
    id: 'c0',
    snapshotId: 'progress-snapshot',
    kind: 'passage',
    label: 'A source passage',
    text: 'A source passage',
    headingPath: [],
    context: '',
    visibility: 'visible',
    actionPolicy: 'read_candidate',
    provenance: 'html',
    contentHash: 'fixture',
  };
  const result = {
    id: 'ai-result',
    kind: 'passage',
    title: 'AI-assessed source',
    url: origin + '/fixtures/journal',
    origin,
    quote: 'A source passage',
    headingPath: [],
    observedAt: new Date().toISOString(),
    evidence: 'direct',
    candidate,
    snapshotId: candidate.snapshotId,
    documentId: 'progress-document',
    local: false,
    provider: 'jev',
  };
  const state = {
    id: 'progress-fixture',
    lifecycle: 'running',
    evidence: 'direct',
    provider: 'lexical_fallback',
    results: [
      result,
      {
        ...result,
        id: 'keyword-result',
        title: 'Keyword source',
        evidence: 'candidate_only',
        provider: 'lexical_fallback',
      },
    ],
    coverage: {
      pagesChecked: 2,
      urlsDiscovered: 12,
      blocked: 0,
      cacheHits: 0,
      providerCalls: 2,
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs: 20,
      scope: 'bounded_site_search',
      limitations: ['provider_unavailable'],
      stopReason: '',
    },
    message: 'Checking related pages',
    requestedSections: [],
    revealSteps: 0,
  };
  let release!: () => void;
  const stream = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.route('**/v1/searches', (route) => route.fulfill({ json: state }));
  await context.route('**/v1/searches/progress-fixture/events', async (route) => {
    await stream;
    await route.fulfill({ contentType: 'text/event-stream', body: '' });
  });
  try {
    await ask('Find a source', 'page');
    const status = chat.getByRole('status');
    await expect(status).toContainText('Checking related pages');
    await expect(status).not.toContainText('keyword');
    await expect(chat.locator('.source').first()).toContainText('SOURCE FOUND');
    await expect(chat.locator('.source')).toHaveCount(1);
    await expect(chat.getByText('Keyword source', { exact: true })).toHaveCount(0);
    await expect(chat.getByText('These are keyword matches only.', { exact: false })).toHaveCount(
      0,
    );
    const sourceBounds = await chat.locator('.source').last().boundingBox();
    const statusBounds = await status.boundingBox();
    expect(statusBounds!.y).toBeGreaterThanOrEqual(sourceBounds!.y + sourceBounds!.height);
    await expect(status.locator('.loading')).toBeVisible();
  } finally {
    release();
    await context.unroute('**/v1/searches');
    await context.unroute('**/v1/searches/progress-fixture/events');
  }
});

for (const failure of ['rate_limit', 'failed'] as const) {
  test(`renders ${failure} as a chat response`, async () => {
    await open();
    const state = {
      id: 'overlay-failure-fixture',
      lifecycle: 'failed',
      evidence: 'none',
      provider: 'jev',
      results: [],
      coverage: {
        pagesChecked: 1,
        urlsDiscovered: 0,
        blocked: 0,
        cacheHits: 0,
        providerCalls: 1,
        inputTokens: 0,
        outputTokens: 0,
        elapsedMs: 20,
        scope: 'current_page',
        limitations: failure === 'rate_limit' ? ['provider_rate_limited'] : [],
        stopReason: failure,
      },
      message:
        failure === 'rate_limit' ? 'TypeSafe rate-limited this search. Try again later.' : '',
      requestedSections: [],
      revealSteps: 0,
    };
    await context.route('**/v1/searches', (route) => route.fulfill({ json: state }));
    await context.route('**/v1/searches/overlay-failure-fixture/events', (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: `id: 1\ndata: ${JSON.stringify({ protocol: 1, id: 1, searchId: state.id, type: 'completed', state })}\n\n`,
      }),
    );
    await ask('Find the beacon detail', 'page');
    await expect(
      chat.getByText(
        failure === 'failed' ? 'The search failed.' : 'TypeSafe rate-limited this search.',
        { exact: false },
      ),
    ).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Stop search' })).toHaveCount(0);
    await context.unroute('**/v1/searches');
    await context.unroute('**/v1/searches/overlay-failure-fixture/events');
  });
}

test('scrolls the conversation to the start of a new reply', async () => {
  await open();
  await chat.evaluate((host: HTMLElement) => {
    const style = document.createElement('style');
    style.textContent = '.user-message,.reply,.source{min-height:220px}';
    host.shadowRoot?.appendChild(style);
  });
  await ask('Which beacon is marked amber?', 'page');
  await expect(chat.locator('blockquote')).toContainText('amber');
  await ask('When do public tours resume?');
  await expect(chat.locator('.latest-reply')).toContainText('next month');
  const log = chat.locator('.conversation');
  const latest = chat.locator('.latest-reply');
  const logBox = await log.boundingBox();
  const replyBox = await latest.boundingBox();
  expect(replyBox!.y).toBeGreaterThanOrEqual(logBox!.y - 4);
  expect(replyBox!.y).toBeLessThan(logBox!.y + 80);
});

test('uses the revised shortcut and gives actionable help without a full-width chat', async () => {
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.commands?._execute_action.suggested_key).toEqual({
    default: 'Alt+Shift+F',
    mac: 'Alt+Shift+F',
  });
  await site.goto(`chrome-extension://${extensionId}/overlay.html?unavailable=restricted`);
  await expect(site.getByRole('heading', { name: 'Couldn’t open on that tab.' })).toBeVisible();
  await expect(
    site.getByText('This tab is protected by the browser.', { exact: false }),
  ).toBeVisible();
  await expect(site.getByLabel('Your request')).toHaveCount(0);
  const width = await site.locator('.launch-help').boundingBox();
  expect(width!.width).toBeLessThanOrEqual(520);
  const opened = context.waitForEvent('page');
  await site.getByRole('button', { name: 'Configure keyboard shortcut' }).click();
  const shortcuts = await opened;
  await shortcuts.waitForLoadState();
  expect(shortcuts.url()).toBe('chrome://extensions/shortcuts');
  await shortcuts.close();
  await site.goto(`chrome-extension://${extensionId}/overlay.html?unavailable=installation`);
  await expect(
    site.getByText('This does not necessarily mean the website is restricted.', { exact: false }),
  ).toBeVisible();
});

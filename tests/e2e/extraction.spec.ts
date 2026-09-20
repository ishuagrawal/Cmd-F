import { test, expect } from '@playwright/test';
import { build } from 'esbuild';

let bundle = '';
test.beforeAll(async () => {
  const built = await build({
    stdin: {
      contents:
        "import { DomSession } from './packages/extraction/src/dom'; globalThis.TestSession = DomSession;",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
  });
  bundle = built.outputFiles[0].text;
});

test('keeps late article quotes after a large chart tree', async ({ page }) => {
  const chart = `<svg aria-hidden="true">${'<g><circle/></g>'.repeat(16500)}</svg>`;
  await page.route('https://fixture.test/**', (route) =>
    route.fulfill({ body: '<html></html>', contentType: 'text/html' }),
  );
  await page.goto('https://fixture.test/');
  await page.setContent(`<!doctype html><main>
    <p>Astra saturates FrontierMath Tier 4 with a 98% score in mathematics.</p>
    ${chart}
    <h2>Coding</h2>
    <blockquote>GPT-6 Astra delivers state-of-the-art performance on our internal coding benchmarks and shows a clear step forward in trading intuition evaluations.</blockquote>
    <p>John Crepezzi, AI Assistants, Jane Street</p>
    <p>The model can bring games to life through vivid graphics and engaging gameplay.</p>
  </main>`);
  await page.addScriptTag({ content: bundle });
  const found = await page.evaluate(async () => {
    type Session = {
      inspect(q: string): {
        id: string;
        sectionIds: string[];
        candidates: { kind: string; text?: string; context?: string; label: string }[];
        discovery: { complete: boolean };
      };
      readSections(id: string, ids: string[]): unknown;
    };
    const session = new (
      globalThis as unknown as { TestSession: new (doc: Document) => Session }
    ).TestSession(document);
    const jane = session.inspect('what did Jane Street say about Astra');
    const games = session.inspect('is Astra good at video games');
    const hay = (c: { text?: string; context?: string; label: string }) =>
      `${c.label} ${c.text || ''} ${c.context || ''}`;
    document
      .querySelector('svg')
      ?.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'circle'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    let chartMutationIgnored = true;
    try {
      session.readSections(games.id, games.sectionIds.slice(0, 1));
    } catch {
      chartMutationIgnored = false;
    }
    return {
      complete: jane.discovery.complete,
      quote: jane.candidates.some((c) => (c.text || '').includes('trading intuition')),
      attributed: jane.candidates.some(
        (c) =>
          (c.text || '').includes('trading intuition') && (c.context || '').includes('Jane Street'),
      ),
      attribution: jane.candidates.some((c) => hay(c).includes('Jane Street')),
      games: games.candidates.some((c) => (c.text || '').includes('bring games to life')),
      chartMutationIgnored,
    };
  });
  expect(found.complete).toBe(true);
  expect(found.quote).toBe(true);
  expect(found.attributed).toBe(true);
  expect(found.attribution).toBe(true);
  expect(found.games).toBe(true);
  expect(found.chartMutationIgnored).toBe(true);
});

test('retakes a live snapshot when the page mutates after inspect', async ({ page }) => {
  await page.route('https://fixture.test/**', (route) =>
    route.fulfill({ body: '<html></html>', contentType: 'text/html' }),
  );
  await page.goto('https://fixture.test/');
  await page.setContent(
    '<!doctype html><main><h2>Coding</h2><p>Following the Hugging Face incident, Astra added controls.</p></main>',
  );
  await page.addScriptTag({ content: bundle });
  const found = await page.evaluate(async () => {
    type Session = {
      inspect(q: string): { id: string; sectionIds: string[]; candidates: { text?: string }[] };
      readSections(id: string, ids: string[]): { id: string; candidates: { text?: string }[] };
    };
    const session = new (
      globalThis as unknown as { TestSession: new (doc: Document) => Session }
    ).TestSession(document);
    const first = session.inspect('what did Astra do after the Hugging Face incident');
    document.querySelector('main')?.setAttribute('class', 'hydrated');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const next = session.readSections(first.id, first.sectionIds.slice(0, 1));
    return {
      kept: next.candidates.some((c) => (c.text || '').includes('Hugging Face incident')),
      retaken: next.id !== first.id,
    };
  });
  expect(found.kept).toBe(true);
  expect(found.retaken).toBe(true);
});

test('Show on page marks the passage with a source bracket', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.route('https://fixture.test/**', (route) =>
    route.fulfill({ body: '<html></html>', contentType: 'text/html' }),
  );
  await page.goto('https://fixture.test/');
  await page.setContent(
    `<!doctype html><main>${'<p>Filler copy for scroll distance.</p>'.repeat(40)}<p id="hit">The visitor beacon at the east entrance is marked amber.</p></main>`,
  );
  await page.addScriptTag({ content: bundle });
  const shown = await page.evaluate(() => {
    type Session = {
      inspect(q: string): {
        id: string;
        documentId: string;
        candidates: { id: string; text?: string }[];
      };
      show(snapshotId: string, candidateId: string, documentId: string): unknown;
    };
    const session = new (
      globalThis as unknown as { TestSession: new (doc: Document) => Session }
    ).TestSession(document);
    const snap = session.inspect('which beacon is amber');
    const candidate = snap.candidates.find((c) => (c.text || '').includes('amber'))!;
    session.show(snap.id, candidate.id, snap.documentId);
    return {
      highlight: CSS.highlights?.has('cmd-f-match') ?? false,
      cue: !!document.querySelector('[data-cmd-f=cue]'),
      tick: !!document.querySelector('[data-cmd-f=tick]'),
      caption: document.querySelector('[data-cmd-f=caption]')?.textContent || '',
      plate: !!document.querySelector('[data-cmd-f=plate]'),
      aperture: !!document.querySelector('[data-cmd-f=aperture]'),
    };
  });
  expect(shown.highlight).toBe(false);
  expect(shown.cue).toBe(true);
  expect(shown.tick).toBe(false);
  expect(shown.caption).toBe('Source');
  expect(shown.plate).toBe(true);
  expect(shown.aperture).toBe(false);
});

test('Show on page keeps the mark on the passage after a manual scroll', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.route('https://fixture.test/**', (route) =>
    route.fulfill({ body: '<html></html>', contentType: 'text/html' }),
  );
  await page.goto('https://fixture.test/');
  await page.setContent(
    `<!doctype html><main>${'<p>Filler copy for scroll distance.</p>'.repeat(40)}<p id="hit">The visitor beacon at the east entrance is marked amber.</p>${'<p>More filler copy for scroll distance.</p>'.repeat(40)}</main>`,
  );
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    type Session = {
      inspect(q: string): {
        id: string;
        documentId: string;
        candidates: { id: string; text?: string }[];
      };
      show(snapshotId: string, candidateId: string, documentId: string): unknown;
    };
    const session = new (
      globalThis as unknown as { TestSession: new (doc: Document) => Session }
    ).TestSession(document);
    const snap = session.inspect('which beacon is amber');
    const candidate = snap.candidates.find((c) => (c.text || '').includes('amber'))!;
    session.show(snap.id, candidate.id, snap.documentId);
  });
  const aligned = () =>
    page.evaluate(() => {
      const plate = document.querySelector('[data-cmd-f=plate]');
      const hit = document.getElementById('hit');
      if (!plate || !hit) return false;
      return (
        Math.abs(plate.getBoundingClientRect().top + 12 - hit.getBoundingClientRect().top) < 16
      );
    });
  await expect.poll(aligned).toBe(true);
  await page.evaluate(() => window.scrollBy(0, 280));
  await expect.poll(aligned).toBe(true);
});

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
        (c) => (c.text || '').includes('trading intuition') && (c.context || '').includes('Jane Street'),
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

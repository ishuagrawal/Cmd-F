import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { SnapshotSchema } from '../packages/contracts/src';
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
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('https://fixture.test/**', (route) =>
    route.fulfill({ body: '<html></html>', contentType: 'text/html' }),
  );
  await page.goto('https://fixture.test/');
  await page.setContent(
    '<main><h1>Catalog</h1>' +
      Array.from(
        { length: 220 },
        (_, i) => `<p>Entry ${i}: ${'Reference information. '.repeat(10)}</p>`,
      ).join('') +
      '<a href="/jobs/engineer">Software engineer</a><a hidden href="/hidden">Software engineer hidden</a></main>',
  );
  await page.addScriptTag({ content: built.outputFiles[0].text });
  const output = await page.evaluate(async () => {
    const session = new (
      globalThis as unknown as {
        TestSession: typeof import('../packages/extraction/src/dom').DomSession;
      }
    ).TestSession(document);
    const first = session.inspect('software engineer');
    const listing = first.candidates.find((c) => c.kind === 'link' && c.visibility !== 'hidden')!;
    const batches = [first];
    let current = first;
    for (let i = 0; i < 4; i++) {
      const group = current.candidates.find((c) => c.kind === 'group');
      if (!group) break;
      current = session.readSections(current.id, [group.sectionId!]);
      batches.push(current);
    }
    if (!listing)
      throw new Error(
        'Missing listing: ' +
          JSON.stringify({
            limit: first.limitations,
            size: first.candidates.length,
            labels: first.candidates.slice(0, 3).map((c) => c.label),
          }),
      );
    session.show(first.id, listing.id, first.documentId);
    const highlighted = !!document.querySelector('[data-cmd-f=outline]');
    const lastPassage = batches
      .flatMap((b) => b.candidates)
      .find((c) => c.text?.startsWith('Entry 219:'))!;
    if (!lastPassage)
      throw new Error(
        'Missing final entry: ' +
          JSON.stringify(
            batches.map((b) => ({
              limit: b.limitations,
              size: b.candidates.length,
              last: b.candidates
                .filter((c) => c.text)
                .at(-1)
                ?.label.slice(0, 50),
            })),
          ),
      );
    session.show(current.id, lastPassage.id, current.documentId);
    const endHighlighted = !!document.querySelector('[data-cmd-f=outline]');
    document.querySelector('main')!.append(document.createElement('p'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    let staleRejected = false;
    try {
      session.readSections(current.id, current.sectionIds.slice(0, 1));
    } catch {
      staleRejected = true;
    }
    session.stop();
    return { batches, highlighted, endHighlighted, staleRejected };
  });
  output.batches.forEach((b) => SnapshotSchema.parse(b));
  const ids = output.batches.flatMap((b) =>
    b.candidates.filter((c) => c.kind !== 'group').map((c) => c.id),
  );
  assert.equal(new Set(ids).size, ids.length, 'section batches must never repeat candidates');
  assert.equal(
    output.batches.flatMap((b) => b.candidates).filter((c) => c.text?.startsWith('Entry ')).length,
    220,
    'all entries in a partially selected section remain accessible',
  );
  assert.ok(output.batches.length > 1);
  assert.ok(
    output.highlighted && output.endHighlighted,
    'old and new candidate anchors remain valid',
  );
  assert.ok(output.staleRejected, 'mutation invalidates section reads');
  console.log(
    `PASS: ${output.batches.length} disjoint batches, all 220 entries, retained anchors, stale-read rejection.`,
  );
} finally {
  await browser.close();
}

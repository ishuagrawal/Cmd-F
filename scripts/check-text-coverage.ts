import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
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
  await page.setContent(`<main><article>
    <div data-testid="postText" lang="en"><span>The archive has a new entry.</span><br><span>Every moment, the reader returns structured data of the current page.</span></div>
    <button>Show more</button>
  </article>
  <div>A plain application text block about a local reference.</div>
  <div contenteditable="true">Private unsent archive draft</div>
  <div hidden lang="en">Hidden archive content</div>
  <div data-cmd-f="overlay">Private overlay request</div></main>`);
  await page.addScriptTag({ content: built.outputFiles[0].text });
  const result = await page.evaluate(() => {
    const session = new (
      globalThis as unknown as {
        TestSession: typeof import('../packages/extraction/src/dom').DomSession;
      }
    ).TestSession(document);
    const snap = session.inspect("where is the archive entry");
    const passages = snap.candidates.filter((c) => c.kind === 'passage');
    const post = passages.find((c) => c.text?.includes('archive has'));
    if (post) session.show(snap.id, post.id, snap.documentId);
    return { passages, outlined: !!document.querySelector('[data-cmd-f="outline"]') };
  });
  assert.equal(result.passages.filter((c) => c.text?.includes('archive has')).length, 1);
  assert.ok(result.passages.some((c) => c.text?.includes('local reference')));
  assert.ok(!JSON.stringify(result.passages).match(/Private unsent|Hidden archive|Private overlay/));
  assert.equal(result.outlined, true);
  for (const tag of [
    'h1',
    'h6',
    'p',
    'li',
    'dt',
    'dd',
    'blockquote',
    'figcaption',
    'address',
    'label',
    'legend',
    'output',
    'div',
    'span',
    'strong',
    'em',
    'small',
    'code',
    'kbd',
    'samp',
    'q',
    'cite',
    'abbr',
    'time',
    'mark',
    'section',
    'article',
  ]) {
      await page.setContent(`<${tag}>Fixture text</${tag}>`);
    const found = await page.evaluate(() => {
      const session = new (
        globalThis as unknown as {
          TestSession: typeof import('../packages/extraction/src/dom').DomSession;
        }
      ).TestSession(document);
      const snapshot = session.inspect('Fixture text');
      session.stop();
      return snapshot.candidates.some((c) => c.kind === 'passage' && c.text === 'Fixture text');
    });
    assert.ok(found, tag);
  }
  console.log(
    'PASS: 27 HTML text elements, app posts, deduplication, privacy exclusions, and highlighting',
  );
} finally {
  await browser.close();
}

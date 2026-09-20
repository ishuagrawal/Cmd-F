import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { config } from 'dotenv';
import { providerFromEnv } from '../packages/jev/src';
import { extractHtml } from '../packages/extraction/src/html';

const bundle = await build({
  stdin: {
    contents: `export { DomSession, safeText, excerptRange } from './packages/extraction/src/dom';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'excerpts',
  platform: 'browser',
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('https://example.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html></html>' }),
  );
  await page.goto('https://example.com/highlight');
  await page.setContent(
    `<h1>Company history</h1><p>Background details precede the answer.\n The board <a href="#">removed the CEO</a> because he was <strong>not consistently candid</strong>.<sup>[3][4]</sup><span hidden>private hidden text</span> More unrelated details follow the answer.</p>`,
  );
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(() => {
    const lib = (window as unknown as { excerpts: typeof import('../packages/extraction/src/dom') })
      .excerpts;
    const session = new lib.DomSession(document);
    const snap = session.inspect();
    const candidate = snap.candidates.find((c) => c.text?.startsWith('Background'))!;
    const quote = 'The board removed the CEO because he was not consistently candid.[3][4]';
    const start = candidate.text!.indexOf(quote);
    session.show(snap.id, candidate.id, snap.documentId, { start, end: start + quote.length });
    const highlights = (CSS as typeof CSS & { highlights: Map<string, Set<Range>> }).highlights;
    const shown = [...highlights.get('cmd-f-match')!][0].toString();
    const outlined = !!document.querySelector('[data-cmd-f=outline]');
    let rejected = false;
    try {
      session.show(snap.id, candidate.id, snap.documentId, { start: 0, end: 100000 });
    } catch {
      rejected = true;
    }
    document.querySelector('strong')!.textContent = 'changed';
    let stale = false;
    try {
      session.show(snap.id, candidate.id, snap.documentId, { start, end: start + quote.length });
    } catch {
      stale = true;
    }
    session.stop();
    return { shown, quote, rejected, stale, outlined };
  });
  assert.equal(result.shown, result.quote);
  assert.equal(result.outlined, false);
  assert.equal(result.rejected, true);
  assert.equal(result.stale, true);
  console.log(
    'Browser: exact inline/citation highlight, invalid offsets and stale-source rejection passed.',
  );
} finally {
  await browser.close();
}

if (process.argv.includes('--live')) {
  config({ quiet: true });
  const provider = providerFromEnv();
  assert.equal(provider.mode, 'jev');
  const text =
    'The company opened its first office many years ago and spent the following decade expanding its research teams across several countries. The board removed the chief executive because he was not consistently candid in his communications.[3][4] In response, the president resigned and a team of advisers coordinated extensive negotiations with employees and investors over the following week.';
  const snapshot = extractHtml(`<p>${text}</p>`, 'https://example.com/history');
  const budget = { calls: 0, bytes: 0, inputTokens: 0, outputTokens: 0 };
  const decision = await provider.select(
    'Why was the chief executive fired?',
    snapshot.candidates,
    new AbortController().signal,
    budget,
  );
  assert.equal(decision.verified, true);
  assert.ok(decision.excerpt);
  const quote = text.slice(decision.excerpt.start, decision.excerpt.end);
  assert.ok(quote.includes('not consistently candid'));
  assert.ok(quote.length < text.length);
  console.log(
    JSON.stringify({
      live: 'passed',
      quote,
      originalLength: text.length,
      excerptLength: quote.length,
      calls: budget.calls,
    }),
  );
}

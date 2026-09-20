import { expect, it } from 'vitest';
import { extractHtml } from '../../packages/extraction/src/html';

const elements = [
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
];
for (const tag of elements) {
  it(`includes standalone ${tag} text`, () => {
    const snapshot = extractHtml(`<${tag}>Fixture text</${tag}>`, 'https://fixture.test');
    expect(snapshot.candidates.some((c) => c.kind === 'passage' && c.text === 'Fixture text')).toBe(
      true,
    );
  });
}
it('keeps inline context once and excludes hidden and editable descendants', () => {
  const snapshot = extractHtml(
    '<div lang="en">A <strong>visible <em>fixture passage.</em></strong><span hidden>secret</span><span contenteditable="true">draft</span></div>',
    'https://fixture.test',
  );
  const passages = snapshot.candidates.filter((c) => c.kind === 'passage');
  expect(passages.map((c) => c.text)).toEqual(['A visible fixture passage.']);
});
it('preserves links and buttons as actionable candidates', () => {
  const snapshot = extractHtml(
    '<p>Try <a href="/fixture">Open fixture</a></p><button><span>Apply</span></button>',
    'https://fixture.test',
  );
  expect(snapshot.candidates.filter((c) => c.kind === 'link')).toHaveLength(1);
  expect(snapshot.candidates.filter((c) => c.kind === 'control')).toHaveLength(1);
  expect(snapshot.candidates.filter((c) => c.kind === 'passage')).toHaveLength(1);
});
it('does not let a page language wrapper swallow its article paragraphs', () => {
  const snapshot = extractHtml(
    `<div lang="en"><nav><a href="/">Home</a></nav><main><h1>Article</h1><p>${'Introduction. '.repeat(750)}</p><p>Experimental compaction keeps notes across context windows and searches previous messages.</p></main></div>`,
    'https://fixture.test',
  );
  expect(
    snapshot.candidates.some(
      (c) =>
        c.text ===
          'Experimental compaction keeps notes across context windows and searches previous messages.' &&
        !c.truncated,
    ),
  ).toBe(true);
  expect(snapshot.candidates.find((c) => c.textRole === 'heading')?.text).toBe('Article');
});
it('keeps a short citation after a blockquote as context', () => {
  const snapshot = extractHtml(
    '<blockquote>Trading intuition evaluations improved.</blockquote><p>John Crepezzi, AI Assistants, Jane Street</p>',
    'https://fixture.test',
  );
  const quote = snapshot.candidates.find((c) => c.text?.includes('Trading intuition'));
  expect(quote?.context).toContain('Jane Street');
});

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
    const snapshot = extractHtml(`<${tag}>Mario demo</${tag}>`, 'https://example.com');
    expect(snapshot.candidates.some((c) => c.kind === 'passage' && c.text === 'Mario demo')).toBe(
      true,
    );
  });
}
it('keeps inline context once and excludes hidden and editable descendants', () => {
  const snapshot = extractHtml(
    '<div lang="en">Jev <strong>beat <em>Super Mario Bros.</em></strong><span hidden>secret</span><span contenteditable="true">draft</span></div>',
    'https://example.com',
  );
  const passages = snapshot.candidates.filter((c) => c.kind === 'passage');
  expect(passages.map((c) => c.text)).toEqual(['Jev beat Super Mario Bros.']);
});
it('preserves links and buttons as actionable candidates', () => {
  const snapshot = extractHtml(
    '<p>Try <a href="/demo">Mario demo</a></p><button><span>Play</span></button>',
    'https://example.com',
  );
  expect(snapshot.candidates.filter((c) => c.kind === 'link')).toHaveLength(1);
  expect(snapshot.candidates.filter((c) => c.kind === 'control')).toHaveLength(1);
  expect(snapshot.candidates.filter((c) => c.kind === 'passage')).toHaveLength(1);
});

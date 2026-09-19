import { it, expect, vi } from 'vitest';
import { rank } from '../../packages/retrieval/src';
import { extractHtml } from '../../packages/extraction/src/html';
import { demoPolicy } from '../../scripts/demo-policy';
import { publicNetworkPolicy } from '../../packages/security/src/network';

it('keeps ordered phrases so for loops ranks above while loops', () => {
  const candidates = ['Python While Loops', 'Python Syntax', 'Python For Loops'].map((label) => ({
    label,
    context: '',
    headingPath: ['Python Tutorial'],
  }));
  expect(rank('how do for loops work', candidates)[0].candidate.label).toBe('Python For Loops');
  expect(rank('how do while loops work', candidates)[0].candidate.label).toBe('Python While Loops');
});
it('keeps article passages and relevant routes after a large navigation menu', () => {
  const nav = Array.from({ length: 700 }, (_, i) => `<a href="/topic/${i}">Lesson ${i}</a>`).join(
    '',
  );
  const snapshot = extractHtml(
    `<nav>${nav}</nav><main><h1>Python For Loops</h1><p>A for loop repeats statements for each item in a sequence.</p><a href="/python/for-loops">Python For Loops</a></main>`,
    'https://example.com/python',
    'how do for loops work',
  );
  expect(
    snapshot.candidates.some((c) => c.kind === 'passage' && c.text?.includes('each item')),
  ).toBe(true);
  expect(snapshot.candidates.some((c) => c.safeUrl?.endsWith('/python/for-loops'))).toBe(true);
  expect(snapshot.candidates.length).toBeLessThanOrEqual(500);
  expect(snapshot.limitations).toContain('snapshot_truncated');
});
it('demo mode delegates public sites to the production network policy', async () => {
  const validate = vi
    .spyOn(publicNetworkPolicy, 'validate')
    .mockResolvedValue({ address: '93.184.216.34', family: 4 });
  try {
    const url = new URL('https://example.com/docs');
    await demoPolicy.validate(url, url.origin);
    expect(validate).toHaveBeenCalledWith(url, url.origin);
    validate.mockClear();
    await demoPolicy.validate(
      new URL('http://127.0.0.1:4318/fixtures/docs'),
      'http://127.0.0.1:4318',
    );
    expect(validate).not.toHaveBeenCalled();
    await expect(
      demoPolicy.validate(new URL('https://example.com/docs'), 'http://127.0.0.1:4318'),
    ).rejects.toThrow();
  } finally {
    validate.mockRestore();
  }
});

it('prefers an event passage over a matching reference title and publication date', () => {
  const candidates = [
    {
      label: 'Morgan testifies at the committee',
      text: 'Published May 15, 2023. Retrieved June 1.',
      context: 'References',
      headingPath: ['Morgan', 'References'],
    },
    {
      label: 'Morgan testified before the committee on May 16, 2023.',
      text: 'Morgan testified before the committee on May 16, 2023.',
      context: '',
      headingPath: ['Morgan', 'Career'],
    },
  ];
  expect(rank('when did Morgan testify', candidates)[0].candidate).toBe(candidates[1]);
});
it('marks only the truncated passage rather than invalidating every source on a page', () => {
  const snapshot = extractHtml(
    `<p>${'Long text '.repeat(1000)}</p><p>The museum opens at nine.</p>`,
    'https://example.com',
  );
  expect(snapshot.limitations).toContain('passage_truncated');
  expect(snapshot.candidates[0].truncated).toBe(true);
  expect(snapshot.candidates[1].truncated).toBe(false);
});

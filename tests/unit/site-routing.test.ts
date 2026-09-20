import { it, expect, vi } from 'vitest';
import { rank } from '../../packages/retrieval/src';
import { extractHtml } from '../../packages/extraction/src/html';
import { demoPolicy } from '../../scripts/demo-policy';
import { publicNetworkPolicy } from '../../packages/security/src/network';

it('keeps ordered phrases so fixed cycles rank above conditional cycles', () => {
  const candidates = ['Conditional Cycles', 'Reference Notes', 'Fixed Cycles'].map((label) => ({
    label,
    context: '',
    headingPath: ['Reference Index'],
  }));
  expect(rank('how do fixed cycles work', candidates)[0].candidate.label).toBe('Fixed Cycles');
  expect(rank('how do conditional cycles work', candidates)[0].candidate.label).toBe(
    'Conditional Cycles',
  );
});
it('keeps article passages and relevant routes after a large navigation menu', () => {
  const nav = Array.from({ length: 700 }, (_, i) => `<a href="/topic/${i}">Lesson ${i}</a>`).join(
    '',
  );
  const snapshot = extractHtml(
    `<nav>${nav}</nav><main><h1>Fixed Cycles</h1><p>A fixed cycle repeats statements for each item in a sequence.</p><a href="/reference/fixed-cycles">Fixed Cycles</a></main>`,
    'https://fixture.test/reference',
    'how do fixed cycles work',
  );
  expect(
    snapshot.candidates.some((c) => c.kind === 'passage' && c.text?.includes('each item')),
  ).toBe(true);
  expect(snapshot.candidates.some((c) => c.safeUrl?.endsWith('/reference/fixed-cycles'))).toBe(
    true,
  );
  expect(snapshot.candidates.length).toBe(703);
  expect(snapshot.limitations).not.toContain('snapshot_truncated');
});
it('demo mode delegates public sites to the production network policy', async () => {
  const validate = vi
    .spyOn(publicNetworkPolicy, 'validate')
    .mockResolvedValue({ address: '93.184.216.34', family: 4 });
  try {
    const url = new URL('https://public.test/docs');
    await demoPolicy.validate(url, url.origin);
    expect(validate).toHaveBeenCalledWith(url, url.origin);
    validate.mockClear();
    await demoPolicy.validate(
      new URL('http://127.0.0.1:4318/fixtures/docs'),
      'http://127.0.0.1:4318',
    );
    expect(validate).not.toHaveBeenCalled();
    await expect(
      demoPolicy.validate(new URL('https://public.test/docs'), 'http://127.0.0.1:4318'),
    ).rejects.toThrow();
  } finally {
    validate.mockRestore();
  }
});

it('prefers an event passage over a matching reference title and publication date', () => {
  const candidates = [
    {
      label: 'Archive note and publication date',
      text: 'Published May 15, 2023. Retrieved June 1.',
      context: 'References',
      headingPath: ['Timeline', 'References'],
    },
    {
      label: 'The report was presented on May 16, 2023.',
      text: 'The report was presented on May 16, 2023.',
      context: '',
      headingPath: ['Timeline', 'Milestone'],
    },
  ];
  expect(rank('when was the report presented', candidates)[0].candidate).toBe(candidates[1]);
});
it('marks only the truncated passage rather than invalidating every source on a page', () => {
  const snapshot = extractHtml(
    `<p>${'Long text '.repeat(1000)}</p><p>The museum opens at nine.</p>`,
    'https://fixture.test',
  );
  expect(snapshot.limitations).toContain('passage_truncated');
  expect(snapshot.candidates[0].truncated).toBe(true);
  expect(snapshot.candidates[1].truncated).toBe(false);
});

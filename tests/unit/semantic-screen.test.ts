import { expect, it, vi } from 'vitest';
import { JevProvider, type ProviderBudget } from '../../packages/jev/src';
import { extractHtml } from '../../packages/extraction/src/html';
const budget = (): ProviderBudget => ({ calls: 0, bytes: 0, inputTokens: 0, outputTokens: 0 });
it('screens every supplied candidate with independent choices in bounded concurrent batches', async () => {
  const seen: string[] = [];
  let active = 0,
    maxActive = 0;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    active++;
    maxActive = Math.max(maxActive, active);
    const body = JSON.parse(init!.body as string);
    const cs = body.state.candidates;
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(64000);
    expect(cs.length).toBeLessThanOrEqual(16);
    seen.push(...cs.map((c: { label: string }) => c.label));
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return new Response(
      JSON.stringify({
        model: 'test',
        answers: Object.fromEntries(
          cs.map((c: { label: string }, i: number) => {
            const choice = c.label.includes('reimbursements') ? 'match' : 'irrelevant';
            expect(body.questions[`c${i}`].instructions).toContain(`candidates[${i}]`);
            return [
              `c${i}`,
              {
                type: 'choice',
                choice,
                probabilities: {
                  match: choice === 'match' ? 1 : 0,
                  route: 0,
                  irrelevant: choice === 'irrelevant' ? 1 : 0,
                },
              },
            ];
          }),
        ),
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    );
  });
  const candidates = extractHtml(
    Array.from(
      { length: 110 },
      (_, i) =>
        `<a href="/${i}">${i === 109 ? 'Returns and reimbursements' : `Unrelated item ${i}`}</a>`,
    ).join(''),
    'https://example.com',
  ).candidates;
  const b = budget();
  const judgments = await new JevProvider('test', 'test', fetcher).screen(
    'get my money back',
    candidates,
    new AbortController().signal,
    b,
  );
  expect(new Set(seen).size).toBe(110);
  expect(judgments).toHaveLength(110);
  expect(judgments.at(-1)?.disposition).toBe('match');
  expect(maxActive).toBe(3);
  expect(b.candidatesAssessed).toBe(110);
});
it('does not silently truncate long source text before semantic screening', async () => {
  const text = 'Unrelated sentence. '.repeat(300) + 'The launch code name is Aurora.';
  const candidates = extractHtml(`<p>${text}</p>`, 'https://example.com').candidates;
  const fetcher = vi.fn(async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    expect(body.state.candidates[0].text).toBe(text);
    return new Response(
      JSON.stringify({
        model: 'test',
        answers: {
          c0: {
            type: 'choice',
            choice: 'match',
            probabilities: { match: 1, route: 0, irrelevant: 0 },
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });
  const result = await new JevProvider('test', 'test', fetcher).screen(
    'code name',
    candidates,
    new AbortController().signal,
    budget(),
  );
  expect(result[0].candidate).toBe(candidates[0]);
});
it('retries malformed screening once and never turns an unknown choice into a match', async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          model: 'test',
          answers: { c0: { type: 'choice', choice: 'invented', probabilities: { invented: 1 } } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
  );
  const candidates = extractHtml('<p>test</p>', 'https://example.com').candidates;
  const b = budget();
  await expect(
    new JevProvider('test', 'test', fetcher).screen(
      'test',
      candidates,
      new AbortController().signal,
      b,
    ),
  ).rejects.toThrow('unknown_choice');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(b.validationFailures).toHaveLength(2);
});
it('cancels concurrent workers and preserves the originating provider error', async () => {
  const fetcher = vi.fn(async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    if (body.state.candidates[0].label === 'Item 0') return new Response('', { status: 401 });
    await new Promise((_resolve, reject) =>
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
    );
    throw new Error('unreachable');
  });
  const cs = extractHtml(
    Array.from({ length: 60 }, (_, i) => `<p>Item ${i}</p>`).join(''),
    'https://example.com',
  ).candidates;
  await expect(
    new JevProvider('test', 'test', fetcher).screen(
      'test',
      cs,
      new AbortController().signal,
      budget(),
    ),
  ).rejects.toThrow('provider_http_401');
  expect(fetcher).toHaveBeenCalledTimes(3);
});

import { describe, expect, it } from 'vitest';
import { excerptOptions } from '../../packages/jev/src/excerpts';
import { JevProvider } from '../../packages/jev/src';
import { extractHtml } from '../../packages/extraction/src/html';

const before =
  'The company was founded many years ago and expanded its offices across several countries while hiring researchers and engineers.';
const answer =
  'The board removed the chief executive because he was not consistently candid in his communications.[3][4]';
const after =
  'The following week involved extensive negotiations among employees, investors, directors and advisers about the future management of the company.';
const passage = `${before} ${answer} ${after}`;

describe('focused source excerpts', () => {
  it.each([true, false])(
    'verifies the full source after an unhelpful shortening; full relevance=%s',
    async (fullRelevant) => {
      const candidates = extractHtml(`<p>${passage}</p>`, 'https://site.test').candidates;
      const checked: string[] = [];
      const fetcher = (async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const key = Object.keys(body.questions)[0];
        const ids = Object.keys(body.questions[key].criteria);
        if (key === 'supported') checked.push(body.state.untrusted_excerpt.text);
        const selected =
          key === 'selection'
            ? candidates[0].id
            : key === 'excerpt'
              ? 's0-1'
              : checked.length === 2 && fullRelevant
                ? 'relevant'
                : 'irrelevant';
        return Response.json({
          model: 'jev-test',
          answers: {
            [key]: {
              type: 'choice',
              choice: selected,
              probabilities: Object.fromEntries(ids.map((id) => [id, id === selected ? 1 : 0])),
            },
          },
          usage: { input_tokens: 10, output_tokens: 1 },
        });
      }) as typeof fetch;
      const budget = { calls: 0, bytes: 0, inputTokens: 0, outputTokens: 0 };
      const decision = await new JevProvider('test', undefined, fetcher).select(
        'Why was the chief executive removed?',
        candidates,
        new AbortController().signal,
        budget,
      );
      expect(checked).toEqual([before, passage]);
      expect(decision.verified).toBe(fullRelevant);
      expect(decision.excerpt).toBeUndefined();
      expect(budget.calls).toBe(4);
    },
  );
  it('offers exact sentence windows including attached citations', () => {
    const options = excerptOptions(passage);
    expect(options.some((o) => o.text === answer)).toBe(true);
    for (const o of options) expect(passage.slice(o.start, o.end)).toBe(o.text);
    expect(excerptOptions(answer)).toEqual([]);
    expect(excerptOptions('x'.repeat(500))).toEqual([]);
  });
  it('selects a source span and independently validates only that span', async () => {
    const candidates = extractHtml(`<p>${passage}</p>`, 'https://site.test').candidates;
    const requests: { state: { untrusted_excerpt: { text: string; label: string } } }[] = [];
    const fetcher = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push(body);
      const key = Object.keys(body.questions)[0];
      const ids = Object.keys(body.questions[key].criteria);
      const selected =
        key === 'selection' ? candidates[0].id : key === 'excerpt' ? 's1-1' : 'relevant';
      return Response.json({
        model: 'jev-test',
        answers: {
          [key]: {
            type: 'choice',
            choice: selected,
            probabilities: Object.fromEntries(ids.map((id) => [id, id === selected ? 1 : 0])),
          },
        },
        usage: { input_tokens: 10, output_tokens: 1 },
      });
    }) as typeof fetch;
    const decision = await new JevProvider('test', undefined, fetcher).select(
      'Why was the chief executive removed?',
      candidates,
      new AbortController().signal,
      { calls: 0, bytes: 0, inputTokens: 0, outputTokens: 0 },
    );
    expect(decision.verified).toBe(true);
    expect(decision.candidate).toEqual(candidates[0]);
    expect(passage.slice(decision.excerpt!.start, decision.excerpt!.end)).toBe(answer);
    expect(requests).toHaveLength(3);
    expect(requests[2].state.untrusted_excerpt.text).toBe(answer);
    expect(requests[2].state.untrusted_excerpt.label).toBe(answer);
  });
});

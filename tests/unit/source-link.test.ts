import { describe, expect, it } from 'vitest';
import { passageUrl } from '../../apps/extension/src/source-link';

describe('external passage links', () => {
  it('targets the quote and retains an existing section anchor', () => {
    expect(
      passageUrl(
        'https://example.com/article#section',
        "But they're beholden, to a state-owned firm.",
      ),
    ).toBe(
      'https://example.com/article#section:~:text=But%20they%27re%20beholden%2C%20to%20a%20state%2Downed%20firm.',
    );
  });
  it('normalizes whitespace and replaces stale text directives', () => {
    expect(passageUrl('https://example.com/#section:~:text=old', ' new\n passage ')).toBe(
      'https://example.com/#section:~:text=new%20passage',
    );
  });
  it('leaves listings without a verified quote unchanged', () => {
    expect(passageUrl('https://example.com/listing')).toBe('https://example.com/listing');
  });
  it('uses a start/end range for long passages', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`);
    expect(passageUrl('https://example.com', words.join(' '))).toBe(
      `https://example.com/#:~:text=${words.slice(0, 12).join('%20')},${words.slice(-12).join('%20')}`,
    );
  });
});

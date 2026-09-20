import { describe, expect, it } from 'vitest';
import type { EvidenceResult } from '../../packages/contracts/src';
import { jumpEnabled, jumpFor, shouldFollow } from '../../apps/extension/src/overlay/jump';

function result(
  over: Partial<EvidenceResult> & Pick<EvidenceResult, 'kind' | 'local'>,
): EvidenceResult {
  return {
    id: 'r1',
    title: 'Source',
    origin: 'example.com',
    quote: 'The visitor beacon is marked amber.',
    headingPath: [],
    observedAt: '2026-09-20T00:00:00.000Z',
    evidence: over.kind === 'listing' ? 'candidate_only' : 'direct',
    candidate: {
      id: 'c1',
      snapshotId: 's1',
      kind: 'passage',
      label: 'Source',
      headingPath: [],
      context: '',
      visibility: 'visible',
      actionPolicy: 'read_candidate',
      provenance: 'live_dom',
      contentHash: 'h1',
    },
    snapshotId: 's1',
    documentId: 'd1',
    provider: 'mock',
    url: 'https://example.com/article',
    ...over,
  };
}

describe('jump preference', () => {
  it('stays off unless storage explicitly enables it', () => {
    expect(jumpEnabled(undefined)).toBe(false);
    expect(jumpEnabled(false)).toBe(false);
    expect(jumpEnabled('true')).toBe(false);
    expect(jumpEnabled(true)).toBe(true);
  });
});

describe('jumpFor', () => {
  it('scrolls a local passage on this page', () => {
    expect(jumpFor(result({ kind: 'page', local: true }))).toEqual({
      kind: 'show',
      result: expect.objectContaining({ local: true }),
    });
  });

  it('opens a new tab for an outgoing page', () => {
    expect(jumpFor(result({ kind: 'page', local: false }))).toEqual({
      kind: 'open',
      url: 'https://example.com/article',
      quote: 'The visitor beacon is marked amber.',
    });
  });

  it('opens a listing without a quote fragment', () => {
    expect(
      jumpFor(result({ kind: 'listing', local: false, url: 'https://example.com/jobs' })),
    ).toEqual({
      kind: 'open',
      url: 'https://example.com/jobs',
    });
  });

  it('skips action-like destinations', () => {
    expect(
      jumpFor(result({ kind: 'page', local: false, url: 'https://example.com/logout' })),
    ).toBeUndefined();
  });
});

describe('shouldFollow', () => {
  it('waits for the finished search and only follows once', () => {
    const base = { enabled: true, searchId: 's1', followedId: undefined, userTookOver: false };
    expect(shouldFollow({ ...base, lifecycle: 'running' })).toBe(false);
    expect(shouldFollow({ ...base, lifecycle: 'completed' })).toBe(true);
    expect(shouldFollow({ ...base, lifecycle: 'completed', followedId: 's1' })).toBe(false);
    expect(shouldFollow({ ...base, lifecycle: 'completed', userTookOver: true })).toBe(false);
    expect(shouldFollow({ ...base, lifecycle: 'completed', enabled: false })).toBe(false);
    expect(shouldFollow({ ...base, lifecycle: 'cancelled' })).toBe(false);
  });
});

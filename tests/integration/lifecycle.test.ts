import { normalizeSearchState } from '../../apps/extension/src/sidepanel/api';
import { it, expect } from 'vitest';
import { SearchSession, defaultLimits } from '../../apps/api/src/search/engine';
import { extractHtml } from '../../packages/extraction/src/html';
import { MockProvider } from '../../packages/jev/src';
import { SafeFetcher } from '../../apps/api/src/fetch/safe-fetch';
import { publicNetworkPolicy } from '../../packages/security/src/network';
import { PublicCache } from '../../apps/api/src/cache/public-cache';
function session(section = false) {
  const snapshot = extractHtml(
    '<h1>Preferences</h1><button>Preferences</button><button>Change alerts</button>',
    'https://fixture.test/settings',
  );
  snapshot.candidates = snapshot.candidates.filter((candidate) => candidate.kind === 'control');
  snapshot.candidates[0].expanded = false;
  snapshot.candidates[0].visibility = 'visible';
  snapshot.candidates[1].visibility = 'hidden';
  snapshot.candidates[1].parentControlId = snapshot.candidates[0].id;
  if (section) {
    snapshot.candidates = [
      {
        ...snapshot.candidates[0],
        kind: 'group',
        label: 'Change alerts',
        sectionId: 'settings-section',
      },
    ];
    snapshot.sectionIds = ['settings-section'];
  }
  const cache = new PublicCache();
  const s = new SearchSession(
    'owner',
    {
      protocol: 1,
      question: 'change alerts',
      scope: 'page',
      snapshot,
      consent: true,
      publicSearchConsent: false,
      refresh: false,
    },
    new MockProvider(),
    new SafeFetcher(publicNetworkPolicy),
    cache,
    defaultLimits,
  );
  return { s, snapshot, cache };
}
it('lease expiration cancels waiting jobs and clears raw input', async () => {
  const { s, cache } = session(true);
  await s.run();
  expect(s.state.lifecycle).toBe('waiting_for_user');
  s.tick(s.lease + 45001);
  expect(s.state.lifecycle).toBe('cancelled');
  expect(s.state.coverage.stopReason).toBe('lease_expired');
  await expect(s.resume(session().snapshot)).rejects.toThrow('not_waiting');
  cache.close();
});
it('rejects reveal snapshots from a different source document', async () => {
  const { s, snapshot, cache } = session(true);
  await s.run();
  await expect(s.resume({ ...snapshot, documentId: 'different-document' })).rejects.toThrow(
    'stale_document',
  );
  s.clear();
  cache.close();
});
it('events are monotonically identified and replay is bounded', () => {
  const { s, cache } = session();
  for (let i = 0; i < 150; i++) s.emit('page_checked');
  expect(s.events.length).toBe(100);
  expect(s.events[0].id).toBe(51);
  expect(s.events.at(-1)?.id).toBe(150);
  s.clear();
  expect(s.events).toHaveLength(0);
  expect(s.state.results).toHaveLength(0);
  cache.close();
});

it('finishes without asking the user to open a closed menu', async () => {
  const { s, snapshot, cache } = session();
  await s.run();
  expect(s.state.lifecycle).toBe('completed');
  expect(s.events.some((event) => event.type === 'needs_user')).toBe(false);
  expect(s.state.message).not.toMatch(/open|inspect again/i);
  await expect(s.resume(snapshot)).rejects.toThrow('not_waiting');
  cache.close();
});

it('turns legacy manual waits into a terminal result without masking real section reads', () => {
  const { s, cache } = session();
  s.state.lifecycle = 'waiting_for_user';
  s.state.message = 'Open a menu, then inspect again';
  const legacy = normalizeSearchState(s.state);
  expect(legacy.lifecycle).toBe('completed');
  expect(legacy.message).not.toMatch(/reading|open|inspect again/i);
  expect(legacy.coverage.stopReason).toBe('manual_inspection_unsupported');
  s.state.requestedSections = ['settings-section'];
  expect(normalizeSearchState(s.state)).toBe(s.state);
  s.clear();
  cache.close();
});

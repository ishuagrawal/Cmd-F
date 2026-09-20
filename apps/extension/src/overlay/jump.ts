import { shareableUrl, actionPolicy } from '../../../../packages/security/src';
import type { EvidenceResult } from '../../../../packages/contracts/src';
import { isExtension } from '../sidepanel/bridge';

const STORAGE = 'jumpToAnswer';

export type JumpAction =
  { kind: 'show'; result: EvidenceResult } | { kind: 'open'; url: string; quote?: string };

export function jumpEnabled(stored: unknown) {
  return stored === true;
}

export function jumpFor(result?: EvidenceResult | null): JumpAction | undefined {
  if (!result) return undefined;
  if (result.local) return { kind: 'show', result };
  const url = result.url && shareableUrl(result.url);
  if (!url || actionPolicy(url) !== 'read_candidate') return undefined;
  if (result.kind !== 'page' && result.kind !== 'listing') return undefined;
  return { kind: 'open', url, quote: result.kind === 'listing' ? undefined : result.quote };
}

export function shouldFollow(opts: {
  enabled: boolean;
  lifecycle?: string;
  searchId?: string;
  followedId?: string;
  userTookOver: boolean;
}) {
  return (
    opts.enabled &&
    opts.lifecycle === 'completed' &&
    !!opts.searchId &&
    opts.followedId !== opts.searchId &&
    !opts.userTookOver
  );
}

export async function readJumpPref() {
  if (isExtension) return jumpEnabled((await chrome.storage.local.get(STORAGE))[STORAGE]);
  try {
    return jumpEnabled(JSON.parse(localStorage.getItem('cmd-f-jump-to-answer') || 'false'));
  } catch {
    return false;
  }
}

export async function saveJumpPref(on: boolean) {
  if (isExtension) {
    if (on) await chrome.storage.local.set({ [STORAGE]: true });
    else await chrome.storage.local.remove(STORAGE);
    return;
  }
  if (on) localStorage.setItem('cmd-f-jump-to-answer', 'true');
  else localStorage.removeItem('cmd-f-jump-to-answer');
}

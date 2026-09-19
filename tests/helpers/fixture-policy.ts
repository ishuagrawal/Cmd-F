// Only imported by demo/test entrypoints. No environment switch or API parameter enables this in production.
import type { NetworkPolicy } from '../../packages/security/src/network';
import { actionPolicy, shareableUrl } from '../../packages/security/src';
const origins = new Set([
  'http://127.0.0.1:4318',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);
export const fixturePolicy: NetworkPolicy = {
  async validate(url, origin) {
    if (
      !origins.has(origin) ||
      url.origin !== origin ||
      !shareableUrl(url.href) ||
      actionPolicy(url.href) !== 'read_candidate'
    )
      throw new Error('fixture_policy_blocked');
    return { address: '127.0.0.1', family: 4 };
  },
};

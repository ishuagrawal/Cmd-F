import { publicNetworkPolicy, type NetworkPolicy } from '../packages/security/src/network';
import { fixturePolicy } from '../tests/helpers/fixture-policy';
const fixtureOrigins = new Set([
  'http://127.0.0.1:4318',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);
// The demo adds owned fixtures to the ordinary public-site policy. It must not
// replace public access, or the real extension can only search its current tab.
export const demoPolicy: NetworkPolicy = {
  validate(url, origin) {
    return fixtureOrigins.has(origin)
      ? fixturePolicy.validate(url, origin)
      : publicNetworkPolicy.validate(url, origin);
  },
};

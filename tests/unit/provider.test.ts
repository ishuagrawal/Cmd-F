import { describe, expect, it } from 'vitest';
import { providerFromEnv, providerFailureReason } from '../../packages/jev/src';

describe('provider configuration', () => {
  it('requires a TypeSafe key', () => {
    expect(() => providerFromEnv({})).toThrow('TYPESAFE_API_KEY');
    expect(() => providerFromEnv({ AI_GATEWAY_API_KEY: 'gateway-only' })).toThrow(
      'TYPESAFE_API_KEY',
    );
  });
  it('uses TypeSafe/Jev and ignores leftover Gateway keys', () => {
    const provider = providerFromEnv({
      TYPESAFE_API_KEY: 'test',
      AI_GATEWAY_API_KEY: 'ignored',
      VERCEL_AI_GATEWAY_KEY: 'ignored',
    });
    expect(provider.mode).toBe('jev');
    expect(provider.transport).toBe('typesafe');
  });
  it('allows tests to inject the keyword mock', () => {
    expect(providerFromEnv({ CMD_F_TEST_PROVIDER: 'mock' }).mode).toBe('mock');
  });
});

it.each([
  [new Error('provider_budget'), 'provider_budget_exhausted'],
  [new DOMException('timed out', 'TimeoutError'), 'provider_timeout'],
  [new Error('invalid_provider_selection'), 'provider_invalid_response'],
  [new Error('provider_http_401'), 'provider_auth_failed'],
  [new Error('provider_payload_budget'), 'provider_payload_limit'],
  [new Error('provider_http_429'), 'provider_rate_limited'],
])('classifies verification failures without exposing error bodies', (error, reason) => {
  expect(providerFailureReason(error)).toBe(reason);
});

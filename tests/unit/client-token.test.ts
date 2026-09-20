import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureClientToken } from '../../scripts/client-token';
import {
  isAuthTokenError,
  resolveClientToken,
} from '../../apps/extension/src/sidepanel/client-token';

describe('client token provisioning', () => {
  it('creates a token file once and reuses it', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cmd-f-token-')), 'client-token');
    const first = ensureClientToken({}, file);
    const second = ensureClientToken({}, file);
    expect(first.length).toBeGreaterThanOrEqual(24);
    expect(second).toBe(first);
    expect(readFileSync(file, 'utf8')).toBe(first);
  });
  it('uses CMD_F_CLIENT_TOKEN when set', () => {
    const token = 'env-token-with-more-than-24-chars';
    expect(ensureClientToken({ CMD_F_CLIENT_TOKEN: token }, '/unused-token-file')).toBe(token);
  });
  it('rejects short tokens', () => {
    expect(() => ensureClientToken({ CMD_F_CLIENT_TOKEN: 'too-short' })).toThrow(
      /at least 24 characters/,
    );
  });
});

describe('extension token selection', () => {
  it('prefers a stored override over the baked token', () => {
    expect(resolveClientToken(' stored-token-value ', 'baked-token-value')).toBe(
      'stored-token-value',
    );
  });
  it('falls back to the baked token when storage is empty', () => {
    expect(resolveClientToken(undefined, 'baked-token-value')).toBe('baked-token-value');
    expect(resolveClientToken('   ', 'baked-token-value')).toBe('baked-token-value');
  });
  it('recognizes connection-token failures', () => {
    expect(
      isAuthTokenError(
        new Error('Connection token is missing or incorrect. Open Connection settings.'),
      ),
    ).toBe(true);
    expect(isAuthTokenError(new Error('The local search service is unavailable.'))).toBe(false);
  });
});

const dist = 'apps/extension/dist';
describe.skipIf(!existsSync(join(dist, 'overlay.html')))('unpacked extension build', () => {
  it('compiles the local token into JS modules rather than HTML', () => {
    const token = ensureClientToken();
    const html = ['overlay.html', 'sidepanel.html']
      .map((file) => readFileSync(join(dist, file), 'utf8'))
      .join('');
    expect(html.includes(token), 'token must not appear in HTML').toBe(false);
    const scripts = readdirSync(join(dist, 'assets')).filter((file) => file.endsWith('.js'));
    expect(
      scripts.some((file) => readFileSync(join(dist, 'assets', file), 'utf8').includes(token)),
      'token must be compiled into the extension JS',
    ).toBe(true);
  });
});

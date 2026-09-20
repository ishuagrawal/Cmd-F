import { describe, it, expect } from 'vitest';
import { shareableUrl, actionPolicy, urlIdentity, redact } from '../../packages/security/src';
import { publicAddress, publicNetworkPolicy } from '../../packages/security/src/network';
import { SnapshotSchema, hash, normalize } from '../../packages/contracts/src';
import { extractHtml } from '../../packages/extraction/src/html';
import { MockProvider, JevProvider, validateChoice } from '../../packages/jev/src';
import { sitemapLocations } from '../../apps/api/src/fetch/discovery';
import { PublicCache } from '../../apps/api/src/cache/public-cache';
const signal = new AbortController().signal;
const budget = () => ({ calls: 0, bytes: 0, inputTokens: 0, outputTokens: 0 });
describe('URL policy', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,hi',
    'https://user:pass@site.test/',
    'https://site.test/?token=abc',
    'https://site.test/confirm/abcdefghijklmnopqrstuvwxyz0123456789',
    'https://site.test/#token=abc',
    'https://site.test/?email=me%40example.com',
  ])('keeps sensitive URL local: %s', (url) => expect(shareableUrl(url)).toBeUndefined());
  it.each([
    '/logout',
    '/sign-out',
    '/settings/apply',
    '/checkout',
    '/activate',
    '/anything?action=delete',
  ])('does not navigate action %s', (path) =>
    expect(actionPolicy('https://site.test' + path)).not.toBe('read_candidate'),
  );
  it.each(['/help/preferences', '/docs/how-to-adjust', '/support/notifications'])(
    'permits help article %s',
    (path) => expect(actionPolicy('https://site.test' + path)).toBe('read_candidate'),
  );
  it('preserves content query order and path case', () =>
    expect(urlIdentity('https://site.test/Docs?a=2&a=1&lang=fr&utm_source=x#section')).toEqual({
      fetchKey: 'https://site.test/Docs?a=2&a=1&lang=fr',
      routeKey: 'https://site.test/Docs?a=2&a=1&lang=fr#section',
    }));
  it('keeps route identity distinct', () =>
    expect(urlIdentity('https://site.test/#/one').routeKey).not.toBe(
      urlIdentity('https://site.test/#/two').routeKey,
    ));
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '192.0.2.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
  ])('rejects nonpublic %s', (ip) => expect(publicAddress(ip)).toBe(false));
  it('accepts globally routable addresses', () => {
    expect(publicAddress('1.1.1.1')).toBe(true);
    expect(publicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('production has no fixture bypass', async () => {
    await expect(
      publicNetworkPolicy.validate(
        new URL('http://127.0.0.1:4318/fixtures/docs'),
        'http://127.0.0.1:4318',
      ),
    ).rejects.toThrow();
    await expect(
      publicNetworkPolicy.validate(new URL('https://127.0.0.1/'), 'https://127.0.0.1'),
    ).rejects.toThrow();
  });
  it('blocks scope escape before DNS', async () =>
    expect(
      publicNetworkPolicy.validate(new URL('https://elsewhere.invalid/'), 'https://example.com'),
    ).rejects.toThrow());
});
describe('source extraction', () => {
  it('excludes credentials and drafts, preserves code and heading provenance', () => {
    const snap = extractHtml(
      '<title>Guide</title><h1>Reference</h1><h2 id="process">Processes</h2><p>Repeat a block.</p><pre>sequence: north, east, south\n  record each item</pre><input value="input-secret"><textarea>draft-secret</textarea><div contenteditable>edited-secret</div><script>script-secret</script>',
      'https://docs.test/',
    );
    expect(JSON.stringify(snap)).not.toMatch(
      /input-secret|draft-secret|edited-secret|script-secret/,
    );
    expect(snap.candidates.find((x) => x.text?.includes('record each item'))?.text).toContain('\n  ');
    expect(snap.candidates.find((x) => x.text?.includes('record each item'))?.headingPath).toEqual([
      'Reference',
      'Processes',
    ]);
    expect(snap.candidates.find((x) => x.text?.includes('record each item'))?.headingId).toBe('process');
  });
  it('resolves base and rejects dangerous destinations', () => {
    const s = extractHtml(
      '<base href="https://site.test/docs/"><a href="chapter">Next</a><a href="javascript:alert(1)">Bad</a>',
      'https://site.test/',
    );
    expect(s.candidates[0].safeUrl).toBe('https://site.test/docs/chapter');
    expect(s.candidates[1].safeUrl).toBeUndefined();
  });
  it('rejects candidate ID collisions and snapshot mismatch', () => {
    const s = extractHtml('<p>One</p>', 'https://site.test/');
    expect(() =>
      SnapshotSchema.parse({ ...s, candidates: [...s.candidates, ...s.candidates] }),
    ).toThrow();
    expect(() =>
      SnapshotSchema.parse({
        ...s,
        candidates: s.candidates.map((c) => ({ ...c, snapshotId: 'stale' })),
      }),
    ).toThrow();
  });
  it('reports login and thin shells', () =>
    expect(extractHtml('<input type=password>', 'https://site.test/').limitations).toEqual(
      expect.arrayContaining(['login_required', 'rendering_needed']),
    ));
  it('normalizes deterministically and redacts common identifiers', () => {
    expect(normalize(' a \n b  ')).toBe('a b');
    expect(hash('a')).toBe(hash('a'));
    expect(redact('person@example.com token=abc')).not.toContain('abc');
  });
  it('rejects XML entities', () =>
    expect(() =>
      sitemapLocations('<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]><urlset/>'),
    ).toThrow());
});
describe('provider validation', () => {
  const candidates = extractHtml(
    '<p>The beacon is marked amber.</p><p>The guide opens at sunrise.</p>',
    'https://site.test',
  ).candidates;
  it('mock returns actual candidate and honest mode', async () => {
    const d = await new MockProvider().select(
      'Which beacon is marked amber?',
      candidates,
      signal,
      budget(),
    );
    expect(d.candidate?.text).toContain('amber');
    expect(d.mode).toBe('mock');
  });
  it('does not force no-answer match', async () =>
    expect(
      (
        await new MockProvider().select(
          'Which instrument measures rainfall?',
          candidates,
          signal,
          budget(),
        )
      ).candidate,
    ).toBeUndefined());
  it.each([
    { type: 'choice', choice: 'invented', confidence: 1, probabilities: { invented: 1 } },
    { type: 'choice', choice: 'c0', confidence: 1, probabilities: { c0: NaN, none: 0 } },
    { type: 'choice', choice: 'c0', confidence: 1, probabilities: { c0: 0.1, none: 0.1 } },
  ])('rejects malformed Choice', (x) => expect(() => validateChoice(x, ['c0', 'none'])).toThrow());
  it('validates a selected excerpt in a separate live-shaped request', async () => {
    const bodies: Record<string, unknown>[] = [];
    const transport = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers:
            bodies.length === 1
              ? {
                  selection: {
                    type: 'choice',
                    choice: 'c0',
                    confidence: 0.9,
                    probabilities: { c0: 0.9, c1: 0.05, none: 0.05 },
                  },
                }
              : {
                  supported: {
                    type: 'choice',
                    choice: 'relevant',
                    probabilities: { relevant: 0.94, irrelevant: 0.06 },
                  },
                },
          usage: { input_tokens: 40, output_tokens: 2 },
        }),
      );
    }) as typeof fetch;
    const d = await new JevProvider('fake-key', 'jev-1.13.0', transport).select(
      'beacon color',
      candidates,
      signal,
      budget(),
    );
    expect(d.support).toBe(0.94);
    expect(bodies.length).toBe(2);
    expect(JSON.stringify(bodies[1])).not.toContain('unrelated-private-value');
  });
  it('retry attempts consume budget and unknown IDs fail', async () => {
    let calls = 0;
    const transport = (async () => {
      calls++;
      return new Response('', { status: 429, headers: { 'retry-after': '10' } });
    }) as typeof fetch;
    const b = budget();
    await expect(
      new JevProvider('fake', 'jev-1.13.0', transport).select('beacon color', candidates, signal, b),
    ).rejects.toThrow('rate_limited');
    expect(calls).toBe(1);
    expect(b.calls).toBe(1);
  });
});
describe('public cache', () => {
  it.each(['private', 'no-store', 'no-cache', 'max-age=0'])('does not store %s', (directive) => {
    const cache = new PublicCache();
    cache.put({
      url: 'https://site.test/',
      body: 'secret',
      status: 200,
      headers: { 'cache-control': directive },
      retrievedAt: new Date().toISOString(),
    });
    expect(cache.get('https://site.test/')).toBeUndefined();
    cache.close();
  });
  it('does not store cookies and returns eligible public artifacts', () => {
    const cache = new PublicCache();
    const a = {
      url: 'https://site.test/',
      body: 'public',
      status: 200,
      headers: {},
      retrievedAt: new Date().toISOString(),
    };
    cache.put({ ...a, headers: { 'set-cookie': 'session=x' } });
    expect(cache.get(a.url)).toBeUndefined();
    cache.put(a);
    expect(cache.get(a.url)?.body).toBe('public');
    cache.close();
  });
});

it('mock support does not promote a half-answer to direct', async () => {
  const candidates = extractHtml(
    '<p>Manage preferences from this page.</p>',
    'https://site.test/',
  ).candidates;
  expect(
    (await new MockProvider().select('change alerts', candidates, signal, budget())).candidate,
  ).toBeUndefined();
});

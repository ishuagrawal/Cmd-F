import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { SafeFetcher } from '../../apps/api/src/fetch/safe-fetch';
import type { NetworkPolicy } from '../../packages/security/src/network';
import { loadRobots, discoverSitemaps } from '../../apps/api/src/fetch/discovery';
import { PublicCache } from '../../apps/api/src/cache/public-cache';
it('pins connections, bounds decompression, honors robots redirects, and captures cookie cache restrictions', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url || '');
    switch (req.url) {
      case '/robots.txt':
        res.end('User-agent: *\nDisallow: /private');
        break;
      case '/redirect':
        res.writeHead(302, { Location: '/private' });
        res.end();
        break;
      case '/bomb':
        res.writeHead(200, { 'Content-Encoding': 'gzip' });
        res.end(gzipSync('a'.repeat(100000)));
        break;
      case '/cookie':
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': ['x=y; Path=/'] });
        res.end('<p>Public?</p>');
        break;
      default:
        res.end('<p>OK</p>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server');
  const origin = `http://owned.fixture.invalid:${address.port}`;
  const policy: NetworkPolicy = {
    async validate(url, scope) {
      if (url.origin !== origin || scope !== origin) throw new Error('blocked');
      return { address: '127.0.0.1', family: 4 };
    },
  };
  try {
    const fetcher = new SafeFetcher(policy);
    const signal = new AbortController().signal;
    const robots = await loadRobots(fetcher, origin, signal);
    await expect(
      fetcher.get(origin + '/redirect', origin, signal, 1000, robots.allows),
    ).rejects.toThrow('robots_disallowed');
    expect(requests).not.toContain('/private');
    await expect(fetcher.get(origin + '/bomb', origin, signal, 1000)).rejects.toThrow(
      'response_decode_failed',
    );
    const artifact = await fetcher.get(origin + '/cookie', origin, signal);
    const cache = new PublicCache();
    cache.put(artifact);
    expect(cache.get(artifact.url)).toBeUndefined();
    cache.close();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
it('compressed sitemap indexes are bounded and cyclic indexes terminate', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    res.setHeader('Content-Type', 'application/gzip');
    res.end(
      gzipSync(
        req.url === '/root.gz'
          ? `<sitemapindex><sitemap><loc>${origin}/root.gz</loc></sitemap><sitemap><loc>${origin}/pages.gz</loc></sitemap></sitemapindex>`
          : `<urlset><url><loc>${origin}/docs/answer</loc></url></urlset>`,
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server');
  const origin = `http://127.0.0.1:${address.port}`;
  const policy: NetworkPolicy = {
    async validate(url) {
      if (url.origin !== origin) throw new Error('blocked');
      return { address: '127.0.0.1', family: 4 };
    },
  };
  try {
    const found = await discoverSitemaps(
      new SafeFetcher(policy),
      origin,
      [origin + '/root.gz'],
      () => true,
      new AbortController().signal,
    );
    expect(found).toEqual([origin + '/docs/answer']);
    expect(calls).toBe(2);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
it('cancellation interrupts a stalled DNS/policy check before any connection', async () => {
  const policy: NetworkPolicy = { validate: () => new Promise(() => {}) };
  const controller = new AbortController();
  const pending = new SafeFetcher(policy, 50).get(
    'https://unresolved.invalid/',
    'https://unresolved.invalid',
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toThrow('fetch_cancelled_or_timeout');
});

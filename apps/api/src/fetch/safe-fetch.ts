import http from 'node:http';
import https from 'node:https';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import type { NetworkPolicy } from '../../../../packages/security/src/network';
export interface Artifact {
  url: string;
  body: string;
  status: number;
  headers: Record<string, string>;
  retrievedAt: string;
}
export class SafeFetcher {
  constructor(
    readonly policy: NetworkPolicy,
    private timeout = 8000,
  ) {}
  async get(
    raw: string,
    origin: string,
    inputSignal: AbortSignal,
    limit = 2_000_000,
    allows?: (url: string) => boolean,
  ): Promise<Artifact> {
    const signal = AbortSignal.any([inputSignal, AbortSignal.timeout(this.timeout)]);
    let url = new URL(raw);
    for (let hop = 0; hop <= 3; hop++) {
      signal.throwIfAborted();
      if (allows && !allows(url.href)) throw new Error('robots_disallowed');
      const target = await new Promise<{ address: string; family: 4 | 6 }>((resolve, reject) => {
        const aborted = () => {
          signal.removeEventListener('abort', aborted);
          reject(new Error('fetch_cancelled_or_timeout'));
        };
        signal.addEventListener('abort', aborted, { once: true });
        this.policy
          .validate(url, origin)
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', aborted));
      });
      signal.throwIfAborted();
      const result = await new Promise<Artifact>((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        // Pin the checked address into the actual connection. No second DNS resolution.
        const req = transport.get(
          url,
          {
            agent: false,
            family: target.family,
            lookup: ((
              _hostname: unknown,
              _options: unknown,
              callback: (err: null, address: string, family: number) => void,
            ) => callback(null, target.address, target.family)) as never,
            headers: {
              'User-Agent': 'Cmd-F/0.1 (+source locator; anonymous bounded search)',
              Accept: 'text/html,application/xhtml+xml,application/xml,text/xml,text/plain',
              'Accept-Encoding': 'gzip, deflate, br',
            },
            signal,
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > limit) {
                req.destroy(new Error('response_too_large'));
                return;
              }
              chunks.push(chunk);
            });
            res.on('error', reject);
            res.on('end', () => {
              try {
                let buffer = Buffer.concat(chunks);
                const encoding = res.headers['content-encoding'];
                if (
                  encoding === 'gzip' ||
                  (!encoding && res.headers['content-type']?.includes('gzip'))
                )
                  buffer = gunzipSync(buffer, { maxOutputLength: limit });
                else if (encoding === 'deflate')
                  buffer = inflateSync(buffer, { maxOutputLength: limit });
                else if (encoding === 'br')
                  buffer = brotliDecompressSync(buffer, { maxOutputLength: limit });
                if (buffer.length > limit) throw new Error('response_too_large');
                const headers = Object.fromEntries(
                  Object.entries(res.headers)
                    .filter(([, v]) => v !== undefined)
                    .map(([k, v]) => [k, Array.isArray(v) ? v.join('; ') : v]),
                ) as Record<string, string>;
                resolve({
                  url: url.href,
                  body: buffer.toString('utf8'),
                  status: res.statusCode || 500,
                  headers,
                  retrievedAt: new Date().toISOString(),
                });
              } catch {
                reject(new Error('response_decode_failed'));
              }
            });
          },
        );
        req.setTimeout(this.timeout, () => req.destroy(new Error('fetch_timeout')));
        const timer = setTimeout(() => req.destroy(new Error('fetch_timeout')), this.timeout);
        req.on('close', () => clearTimeout(timer));
        req.on('error', reject);
      });
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        if (!result.headers.location || hop === 3) throw new Error('redirect_limit');
        url = new URL(result.headers.location, url);
        continue;
      }
      return result;
    }
    throw new Error('redirect_limit');
  }
}

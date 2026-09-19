import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import '../../../scripts/load-env';
import { providerFromEnv } from '../../../packages/jev/src';
export function config() {
  mkdirSync('.local', { recursive: true });
  let token = process.env.CMD_F_CLIENT_TOKEN;
  if (!token) {
    try {
      token = readFileSync('.local/client-token', 'utf8').trim();
    } catch {
      token = randomBytes(32).toString('hex');
      writeFileSync('.local/client-token', token, { mode: 0o600 });
    }
  }
  const integer = (name: string, fallback: number, max: number) =>
    z.coerce
      .number()
      .int()
      .positive()
      .max(max)
      .parse(process.env[name] || fallback);
  if (process.env.ENABLE_RENDERER === 'true')
    throw new Error('Renderer is unavailable until network isolation is deployed.');
  return {
    tokens: [token],
    provider: providerFromEnv(),
    port: integer('API_PORT', 4317, 65535),
    allowedOrigins: (
      process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173'
    ).split(','),
    fetchTimeout: integer('FETCH_TIMEOUT_MS', 8000, 10000),
    cachePath: process.env.CACHE_PATH || '.local/public-cache.sqlite',
    cacheTtl: integer('CACHE_TTL_MS', 900000, 900000),
    limits: {
      maxPages: integer('MAX_PAGES', 5, 20),
      maxUrls: integer('MAX_URLS', 5000, 5000),
      deadlineMs: integer('SEARCH_DEADLINE_MS', 30000, 30000),
      leaseMs: integer('LEASE_MS', 45000, 45000),
      ttlMs: integer('SESSION_TTL_MS', 600000, 600000),
    },
  };
}

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { SearchRequestSchema, SnapshotSchema } from '../../../packages/contracts/src';
import type { Provider } from '../../../packages/jev/src';
import { publicNetworkPolicy, type NetworkPolicy } from '../../../packages/security/src/network';
import { SearchSession, defaultLimits, type Limits } from './search/engine';
import { SafeFetcher } from './fetch/safe-fetch';
import { PublicCache } from './cache/public-cache';
export interface ServerOptions {
  tokens: string[];
  provider: Provider;
  policy?: NetworkPolicy;
  cache?: PublicCache;
  limits?: Limits;
  allowedOrigins?: string[];
  fetchTimeout?: number;
}
export async function createServer(options: ServerOptions) {
  if (options.tokens.some((t) => t.length < 24) || !options.tokens.length)
    throw new Error('Client tokens must have at least 24 characters');
  const app = Fastify({ logger: false, bodyLimit: 100000, requestTimeout: 10000 });
  const sessions = new Map<string, SearchSession>();
  const cache = options.cache || new PublicCache();
  const limits = options.limits || defaultLimits;
  await app.register(cors, {
    origin: (origin, cb) =>
      cb(
        null,
        !origin ||
          !!options.allowedOrigins?.includes(origin) ||
          /^chrome-extension:\/\/[a-p]{32}$/.test(origin),
      ),
    allowedHeaders: ['Authorization', 'Content-Type', 'Last-Event-ID'],
    methods: ['GET', 'POST', 'DELETE'],
  });
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/healthz' || req.method === 'OPTIONS') return;
    const provided = req.headers.authorization?.replace(/^Bearer /, '') || '';
    const ok = options.tokens.some((token) => {
      const a = Buffer.from(provided),
        b = Buffer.from(token);
      return a.length === b.length && timingSafeEqual(a, b);
    });
    if (!ok) return reply.code(401).send({ error: 'unauthorized' });
  });
  const owner = (authorization?: string) =>
    createHash('sha256')
      .update(authorization || '')
      .digest('hex');
  const owned = (id: string, auth?: string) => {
    const s = sessions.get(id);
    return s?.owner === owner(auth) ? s : undefined;
  };
  app.setErrorHandler((err, _req, reply) => {
    reply
      .code(
        err instanceof z.ZodError
          ? 400
          : typeof (err as { statusCode?: number }).statusCode === 'number'
            ? (err as { statusCode: number }).statusCode
            : 400,
      )
      .send({ error: err instanceof z.ZodError ? 'invalid_request' : 'request_rejected' });
  });
  app.get('/healthz', async () => ({ ok: true, product: 'Cmd-F', protocol: 1 }));
  app.get('/v1/config', async () => ({
    provider: options.provider.mode,
    transport: options.provider.transport,
    renderer: false,
  }));
  app.post('/v1/searches', async (req, reply) => {
    const request = SearchRequestSchema.parse(req.body);
    if (Buffer.byteLength(JSON.stringify(request.snapshot)) > 80000)
      return reply.code(413).send({ error: 'snapshot_too_large' });
    if (new URL(request.snapshot.origin).origin !== request.snapshot.origin)
      return reply.code(400).send({ error: 'invalid_origin' });
    if (request.snapshot.url && new URL(request.snapshot.url).origin !== request.snapshot.origin)
      return reply.code(400).send({ error: 'origin_mismatch' });
    const who = owner(req.headers.authorization);
    if (
      sessions.size >= 100 ||
      [...sessions.values()].filter(
        (s) => s.owner === who && ['running', 'waiting_for_user'].includes(s.state.lifecycle),
      ).length >= 3
    )
      return reply.code(429).send({ error: 'session_limit' });
    const s = new SearchSession(
      who,
      request,
      options.provider,
      new SafeFetcher(options.policy || publicNetworkPolicy, options.fetchTimeout),
      cache,
      limits,
    );
    sessions.set(s.id, s);
    setTimeout(() => void s.run(), 0);
    return reply.code(201).send(s.state);
  });
  app.get<{ Params: { id: string } }>('/v1/searches/:id', async (req, reply) => {
    const s = owned(req.params.id, req.headers.authorization);
    return s ? s.state : reply.code(404).send({ error: 'search_not_found' });
  });
  app.post<{ Params: { id: string } }>('/v1/searches/:id/lease', async (req, reply) => {
    const s = owned(req.params.id, req.headers.authorization);
    if (!s) return reply.code(404).send({ error: 'search_not_found' });
    s.lease = Date.now();
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/v1/searches/:id/cancel', async (req, reply) => {
    const s = owned(req.params.id, req.headers.authorization);
    if (!s) return reply.code(404).send({ error: 'search_not_found' });
    s.cancel();
    return s.state;
  });
  app.delete<{ Params: { id: string } }>('/v1/searches/:id', async (req, reply) => {
    const s = owned(req.params.id, req.headers.authorization);
    if (!s) return reply.code(404).send({ error: 'search_not_found' });
    s.clear();
    sessions.delete(s.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/v1/searches/:id/snapshot', async (req, reply) => {
    const s = owned(req.params.id, req.headers.authorization);
    if (!s) return reply.code(404).send({ error: 'search_not_found' });
    const snapshot = SnapshotSchema.parse(req.body);
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 80000)
      return reply.code(413).send({ error: 'snapshot_too_large' });
    await s.resume(snapshot);
    return s.state;
  });
  app.get<{ Params: { id: string } }>('/v1/searches/:id/events', async (req, reply) => {
    const s = owned(req.params.id, req.headers.authorization);
    if (!s) return reply.code(404).send({ error: 'search_not_found' });
    if (s.listeners.size >= 3) return reply.code(429).send({ error: 'stream_limit' });
    const cursor = Number(req.headers['last-event-id'] || 0);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      ...Object.fromEntries(Object.entries(reply.getHeaders()).filter(([, v]) => v !== undefined)),
    });
    reply.hijack();
    const send = (event: (typeof s.events)[number]) => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        if (['completed', 'cancelled', 'failed'].includes(event.state.lifecycle)) reply.raw.end();
      }
    };
    s.events.filter((e) => e.id > cursor).forEach(send);
    if (reply.raw.writableEnded) return;
    s.listeners.add(send);
    const heartbeat = setInterval(() => {
      if (!sessions.has(s.id)) {
        reply.raw.end();
        return;
      }
      if (!reply.raw.destroyed) reply.raw.write(': keepalive\n\n');
    }, 15000);
    reply.raw.on('close', () => {
      clearInterval(heartbeat);
      s.listeners.delete(send);
    });
  });
  const sweep = setInterval(() => {
    for (const [id, s] of sessions) {
      s.tick(Date.now());
      if (Date.now() - s.born > limits.ttlMs || Date.now() - s.lease > limits.leaseMs) {
        s.clear();
        sessions.delete(id);
      }
    }
  }, 1000);
  sweep.unref();
  app.addHook('onClose', async () => {
    clearInterval(sweep);
    sessions.forEach((s) => s.clear());
    cache.close();
  });
  return app;
}

import { createServer } from './server';
import { config } from './config';
import { PublicCache } from './cache/public-cache';
const cfg = config();
const app = await createServer({ ...cfg, cache: new PublicCache(cfg.cachePath, cfg.cacheTtl) });
await app.listen({ host: '127.0.0.1', port: cfg.port });
console.log(
  `Cmd-F API: http://127.0.0.1:${cfg.port} (${cfg.provider.mode}). Client token: .local/client-token`,
);
for (const s of ['SIGINT', 'SIGTERM'] as const)
  process.on(s, () => void app.close().then(() => process.exit(0)));

import { createServer as createViteServer } from 'vite';
import { createServer } from '../apps/api/src/server';
import { config } from '../apps/api/src/config';
import { PublicCache } from '../apps/api/src/cache/public-cache';
import { fixtureServer } from '../packages/fixtures/src/server';
const demo = process.argv.includes('--demo');
const cfg = config();
const policy = demo ? (await import('./demo-policy')).demoPolicy : undefined;
const api = await createServer({
  ...cfg,
  policy,
  cache: new PublicCache(cfg.cachePath, cfg.cacheTtl),
});
await api.listen({ host: '127.0.0.1', port: cfg.port });
const fixtures = await fixtureServer();
await fixtures.listen({ host: '127.0.0.1', port: 4318 });
const vite = await createViteServer({
  configFile: 'apps/extension/vite.config.ts',
  plugins: [
    {
      name: 'local-demo-config',
      configureServer(server) {
        server.middlewares.use('/__dev/config', (req, res) => {
          if (
            !['127.0.0.1:5173', 'localhost:5173'].includes(req.headers.host || '') ||
            (req.headers.origin && !cfg.allowedOrigins.includes(req.headers.origin))
          ) {
            res.statusCode = 403;
            res.end();
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(
            JSON.stringify({ token: cfg.tokens[0], api: `http://127.0.0.1:${cfg.port}`, demo }),
          );
        });
      },
    },
  ],
});
await vite.listen();
console.log(
  `Cmd-F: http://127.0.0.1:5173/sidepanel.html\nProvider: ${cfg.provider.mode}. Fixture crawling: ${demo ? 'enabled in this demo process only' : 'disabled (pnpm demo to enable)'}.`,
);
for (const s of ['SIGINT', 'SIGTERM'] as const)
  process.on(
    s,
    () =>
      void Promise.all([vite.close(), api.close(), fixtures.close()]).then(() => process.exit(0)),
  );

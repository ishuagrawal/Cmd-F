import { build as viteBuild } from 'vite';
import { apiOrigin } from './api-origin';
const api = apiOrigin();
import { build } from 'esbuild';
import { writeFile, mkdir } from 'node:fs/promises';
await viteBuild({ configFile: 'apps/extension/vite.config.ts' });
for (const name of ['background', 'content', 'overlay-host'])
  await build({
    entryPoints: [`apps/extension/src/${name}/index.ts`],
    bundle: true,
    format: name === 'background' ? 'esm' : 'iife',
    target: 'chrome120',
    outfile: `apps/extension/dist/${name}.js`,
    sourcemap: true,
  });
const test = process.env.TEST_EXTENSION === '1';
await writeFile(
  'apps/extension/dist/manifest.json',
  JSON.stringify(
    {
      manifest_version: 3,
      name: test ? 'Cmd-F · Test fixtures' : 'Cmd-F',
      version: '0.1.0',
      description: 'Ask what you need. Find the real source.',
      minimum_chrome_version: '120',
      permissions: ['activeTab', 'scripting', 'storage'],
      host_permissions: [`${api}/*`, ...(test ? ['http://127.0.0.1:4318/*'] : [])],
      background: { service_worker: 'background.js', type: 'module' },
      action: { default_title: 'Open Cmd-F' },
      commands: {
        _execute_action: {
          suggested_key: { default: 'Alt+Shift+F', mac: 'Alt+Shift+F' },
          description: 'Open Cmd-F on this page',
        },
      },
      web_accessible_resources: [
        { resources: ['overlay.html'], matches: ['http://*/*', 'https://*/*'] },
      ],
      content_security_policy: {
        extension_pages: `script-src 'self'; object-src 'self'; connect-src ${api}`,
      },
    },
    null,
    2,
  ),
);
await mkdir('apps/api/dist', { recursive: true });
await build({
  entryPoints: ['apps/api/src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  target: 'node24',
  outfile: 'apps/api/dist/main.js',
  sourcemap: true,
});
console.log(`Built ${test ? 'test-only' : 'production'} unpacked extension: apps/extension/dist`);

import { build as viteBuild } from 'vite';
import { apiOrigin } from './api-origin';
import { ensureClientToken } from './client-token';
const api = apiOrigin();
import { build } from 'esbuild';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
await viteBuild({ configFile: 'apps/extension/vite.config.ts' });
const overlayCssName = (await readdir('apps/extension/dist/assets')).find((file) =>
  /^overlay-[\w-]+\.css$/.test(file),
);
if (!overlayCssName) throw new Error('Overlay CSS was not built.');
const overlayCss = await readFile(`apps/extension/dist/assets/${overlayCssName}`, 'utf8');
for (const name of ['background', 'content', 'overlay-host'])
  await build({
    entryPoints: [`apps/extension/src/${name}/index.ts`],
    bundle: true,
    format: name === 'background' ? 'esm' : 'iife',
    target: 'chrome120',
    outfile: `apps/extension/dist/${name}.js`,
    sourcemap: true,
    jsx: 'automatic',
    define:
      name === 'overlay-host'
        ? {
            __OVERLAY_CSS__: JSON.stringify(overlayCss),
            'import.meta.env.VITE_API_BASE_URL': JSON.stringify(api),
            'import.meta.env.VITE_CLIENT_TOKEN': JSON.stringify(ensureClientToken()),
          }
        : name === 'background'
          ? { __CMD_F_API__: JSON.stringify(api) }
          : undefined,
    plugins:
      name === 'overlay-host'
        ? [
            {
              name: 'css-stub',
              setup(build) {
                build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
              },
            },
          ]
        : undefined,
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

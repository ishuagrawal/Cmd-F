import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
mkdirSync('artifacts', { recursive: true });
const archive = resolve('artifacts/cmd-f-extension.zip');
const result = spawnSync(
  'python3',
  [
    '-c',
    'import os,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as z:\n for root,dirs,files in os.walk("apps/extension/dist"):\n  for f in files:\n   p=os.path.join(root,f);z.write(p,os.path.relpath(p,"apps/extension/dist"))',
    archive,
  ],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status || 1);
console.log(archive);

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import './load-env.ts';

export function ensureClientToken(
  env: NodeJS.ProcessEnv = process.env,
  file = '.local/client-token',
): string {
  const fromEnv = env.CMD_F_CLIENT_TOKEN?.trim();
  let token = fromEnv || '';
  if (!token) {
    try {
      token = readFileSync(file, 'utf8').trim();
    } catch {
      token = '';
    }
  }
  if (!token) {
    token = randomBytes(32).toString('hex');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, token, { mode: 0o600 });
  }
  if (token.length < 24) throw new Error('Client tokens must have at least 24 characters');
  return token;
}

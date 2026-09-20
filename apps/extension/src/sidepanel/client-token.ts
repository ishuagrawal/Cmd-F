const extensionRuntime = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

export function bakedClientToken(): string {
  const value = import.meta.env.VITE_CLIENT_TOKEN;
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveClientToken(stored: unknown, baked = bakedClientToken()): string {
  return typeof stored === 'string' && stored.trim() ? stored.trim() : baked;
}

export async function readClientToken(): Promise<string> {
  if (extensionRuntime) {
    const stored = (await chrome.storage.local.get('clientToken')).clientToken;
    return resolveClientToken(stored);
  }
  const baked = bakedClientToken();
  if (baked) return baked;
  try {
    const cfg = await fetch('/__dev/config').then((r) => r.json());
    return typeof cfg.token === 'string' ? cfg.token.trim() : '';
  } catch {
    return '';
  }
}

export async function saveClientToken(token: string) {
  if (!extensionRuntime) return;
  const trimmed = token.trim();
  const baked = bakedClientToken();
  if (!trimmed || trimmed === baked) await chrome.storage.local.remove('clientToken');
  else await chrome.storage.local.set({ clientToken: trimmed });
}

export function isAuthTokenError(error: unknown) {
  return error instanceof Error && error.message.includes('Connection token');
}

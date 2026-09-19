export type LaunchFailure = 'restricted' | 'permission' | 'installation';
export function launchFailure(url = '', error: unknown = undefined): LaunchFailure {
  const message = error instanceof Error ? error.message : String(error || '');
  if (url && !/^https?:\/\//i.test(url)) return 'restricted';
  try {
    const page = new URL(url);
    if (
      page.hostname === 'chromewebstore.google.com' ||
      (page.hostname === 'chrome.google.com' && page.pathname.startsWith('/webstore'))
    )
      return 'restricted';
  } catch {
    /* The browser may omit a tab URL until access is granted. */
  }
  if (/cannot access (?:a |an )?chrome|extensions gallery/i.test(message)) return 'restricted';
  if (/permission|cannot access contents|not allowed/i.test(message)) return 'permission';
  return 'installation';
}

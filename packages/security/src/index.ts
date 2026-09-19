// Browser-safe policy. Server IP / DNS checks live in network.ts.
const actionSegment =
  /(?:^|\/)(?:logout|log-out|signout|sign-out|unsubscribe|delete|destroy|checkout|purchase|cancel|revoke|terminate|activate|deactivate)(?:\/|$)/i;
const sensitiveKey =
  /^(?:token|access_token|auth|authorization|key|api_key|secret|password|session|sessionid|sid|code|signature|sig|ticket|csrf|email)$/i;
export function shareableUrl(raw: string, base?: string): string | undefined {
  try {
    const u = new URL(raw, base);
    if (
      !['https:', 'http:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.href.length > 2048
    )
      return;
    const decoded = decodeURIComponent(u.pathname + u.hash);
    if (
      /[A-Za-z0-9_-]{32,}/.test(decoded) ||
      /\b[^/\s]+@[^/\s]+\./.test(decoded) ||
      /(?:token|password|secret|auth)=/i.test(decoded)
    )
      return;
    for (const k of u.searchParams.keys()) {
      if (sensitiveKey.test(k) || /[A-Za-z0-9_-]{32,}/.test(u.searchParams.get(k) || '')) return;
    }
    for (const k of [...u.searchParams.keys()])
      if (/^utm_|^(fbclid|gclid|mc_cid|mc_eid)$/i.test(k)) u.searchParams.delete(k);
    return u.href;
  } catch {
    return;
  }
}
export function actionPolicy(raw: string): 'read_candidate' | 'highlight_only' | 'needs_review' {
  const safe = shareableUrl(raw);
  if (!safe) return 'highlight_only';
  const u = new URL(safe);
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return 'highlight_only';
  }
  // Informational help routes remain readable, including /help/cancel.
  const informational = /\/(?:help|docs?|support|articles?|guide|tutorial|learn)(?:\/|$)/i.test(
    path,
  );
  if ([...u.searchParams.keys()].some((k) => /^(action|do|cmd|method|confirm|execute)$/i.test(k)))
    return 'highlight_only';
  if (actionSegment.test(path) && !informational) return 'highlight_only';
  if (/\/(?:account|settings|billing|admin|profile|membership)(?:\/|$)/i.test(path))
    return 'needs_review';
  return 'read_candidate';
}
export function urlIdentity(raw: string) {
  const safe = shareableUrl(raw);
  if (!safe) throw new Error('sensitive_url');
  const u = new URL(safe);
  const routeKey = u.href;
  u.hash = '';
  return { fetchKey: u.href, routeKey };
}
export function redact(text: string) {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email removed]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[number removed]')
    .replace(
      /\b(?:Bearer\s+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*)[\w./+=-]+/gi,
      '[secret removed]',
    );
}

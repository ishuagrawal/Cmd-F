const isolatedEvents = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste'] as const;

export function isolateOverlayEvents(root: EventTarget) {
  for (const type of isolatedEvents)
    root.addEventListener(type, (event) => event.stopPropagation());
}

// Accepts both a live overlay element and a stand-in: a real element's
// getRootNode() is typed as Node, which no `host`-bearing shape can describe.
export function pageHoldsFocus(
  active: unknown,
  overlay: { contains(node: unknown): boolean; getRootNode(): unknown } | null,
) {
  if (active == null || !overlay) return false;
  if (typeof Element !== 'undefined' && active instanceof Element) {
    const doc = active.ownerDocument;
    if (active === doc.body || active === doc.documentElement) return false;
  }
  if (overlay.contains(active)) return false;
  const root = overlay.getRootNode();
  const host = typeof root === 'object' && root ? (root as { host?: unknown }).host : undefined;
  return host !== active;
}

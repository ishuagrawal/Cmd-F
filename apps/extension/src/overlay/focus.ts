const isolatedEvents = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste'] as const;

export function isolateOverlayEvents(root: EventTarget) {
  for (const type of isolatedEvents)
    root.addEventListener(type, (event) => event.stopPropagation());
}

export function pageHoldsFocus(
  active: unknown,
  overlay: { contains(node: unknown): boolean; getRootNode(): { host?: unknown } } | null,
) {
  if (active == null || !overlay) return false;
  if (typeof Element !== 'undefined' && active instanceof Element) {
    const doc = active.ownerDocument;
    if (active === doc.body || active === doc.documentElement) return false;
  }
  if (overlay.contains(active)) return false;
  return overlay.getRootNode()?.host !== active;
}

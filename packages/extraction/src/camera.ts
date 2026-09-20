export type Box = { left: number; top: number; width: number; height: number };

export function cameraDuration(px: number) {
  return Math.round(Math.min(1100, Math.max(480, 420 + Math.abs(px) * 0.38)));
}

function sample(t: number, p1: number, p2: number) {
  const mt = 1 - t;
  return 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t;
}

function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 24; i++) {
      const guess = sample(t, x1, x2);
      if (guess < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sample(t, y1, y2);
  };
}

const easeOut = cubicBezier(0.23, 1, 0.32, 1);
const easeDrawer = cubicBezier(0.32, 0.72, 0, 1);

export function cameraProgress(t: number, distance: number) {
  const u = Math.min(1, Math.max(0, t));
  if (u === 0) return 0;
  if (u === 1) return 1;
  if (Math.abs(distance) < 80) return easeDrawer(u);
  const back = Math.min(0.05, 28 / Math.abs(distance));
  const past = Math.min(0.035, 18 / Math.abs(distance));
  const windup = 0.12;
  const settle = 0.16;
  if (u < windup) return -back * easeOut(u / windup);
  if (u < 1 - settle) {
    const k = (u - windup) / (1 - windup - settle);
    return -back + (1 + past + back) * easeDrawer(k);
  }
  const k = (u - (1 - settle)) / settle;
  return 1 + past * (1 - easeOut(k));
}

export function centerDelta(box: Box, viewTop: number, viewHeight: number) {
  return box.top + box.height / 2 - (viewTop + viewHeight / 2);
}

const PAD = 12;
const CHIP = 36;

export function markLayout(box: Box) {
  const plateLeft = Math.max(8, box.left - PAD);
  const plateTop = Math.max(8, box.top - PAD);
  return {
    plate: {
      width: box.width + PAD * 2,
      height: box.height + PAD * 2,
      transform: `translate3d(${plateLeft}px, ${plateTop}px, 0)`,
    },
    chip: {
      transform: `translate3d(${Math.max(8, box.left)}px, ${Math.max(8, box.top - CHIP)}px, 0)`,
    },
  };
}

export function prefersReducedMotion(win: Window) {
  return !!win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
}

type ScrollNode = Window | Element;

function isWindow(node: ScrollNode): node is Window {
  return typeof Window !== 'undefined' && node instanceof Window;
}

function readScroll(node: ScrollNode) {
  return isWindow(node) ? node.scrollY : (node as Element).scrollTop;
}

function writeScroll(node: ScrollNode, top: number) {
  const next = clampScroll(node, top);
  if (isWindow(node)) node.scrollTo({ top: next, behavior: 'instant' });
  else (node as HTMLElement).scrollTop = next;
}

function viewportOf(node: ScrollNode) {
  if (isWindow(node)) return { top: 0, height: node.innerHeight };
  const r = (node as Element).getBoundingClientRect();
  return { top: r.top, height: r.height };
}

function clampScroll(node: ScrollNode, top: number) {
  const max = isWindow(node)
    ? Math.max(0, (node.document.documentElement.scrollHeight || 0) - node.innerHeight)
    : Math.max(0, (node as Element).scrollHeight - (node as Element).clientHeight);
  return Math.min(max, Math.max(0, top));
}

function scrollParents(el: Element): ScrollNode[] {
  const nodes: ScrollNode[] = [];
  const win = el.ownerDocument.defaultView;
  if (!win) return nodes;
  let n: Element | null = el.parentElement;
  while (n && n !== el.ownerDocument.documentElement) {
    if (!n.closest('[data-cmd-f]')) {
      const style = win.getComputedStyle(n);
      if (/(auto|scroll|overlay)/.test(style.overflowY) && n.scrollHeight > n.clientHeight + 1)
        nodes.push(n);
    }
    n = n.parentElement;
  }
  nodes.push(win);
  return nodes;
}

export function planScroll(el: Element, getBox: () => Box) {
  const nodes = scrollParents(el);
  const from = nodes.map(readScroll);
  const to: number[] = [];
  for (const node of nodes) {
    const box = getBox();
    const view = viewportOf(node);
    const next = clampScroll(node, readScroll(node) + centerDelta(box, view.top, view.height));
    writeScroll(node, next);
    to.push(next);
  }
  nodes.forEach((node, i) => writeScroll(node, from[i]!));
  return { nodes, from, to };
}

export function aimAt(el: Element, getBox: () => Box) {
  const path = planScroll(el, getBox);
  path.nodes.forEach((node, i) => writeScroll(node, path.to[i]!));
  return path;
}

export function glideTo(
  el: Element,
  motion: { cancelled: boolean },
  getBox: () => Box,
  onFrame?: (t: number) => void,
) {
  const win = el.ownerDocument.defaultView;
  if (!win) return Promise.resolve();
  if (prefersReducedMotion(win)) {
    aimAt(el, getBox);
    onFrame?.(1);
    return Promise.resolve();
  }
  const path = planScroll(el, getBox);
  const distance = path.from.reduce(
    (max, start, i) => Math.max(max, Math.abs((path.to[i] || 0) - start)),
    0,
  );
  const finish = () => {
    path.nodes.forEach((node, i) => writeScroll(node, path.to[i]!));
    const extra = planScroll(el, getBox);
    extra.nodes.forEach((node, i) => writeScroll(node, extra.to[i]!));
    onFrame?.(1);
  };
  if (distance < 2) {
    finish();
    return Promise.resolve();
  }
  const duration = cameraDuration(distance);
  const started = performance.now();
  const stop = () => {
    motion.cancelled = true;
  };
  win.addEventListener('wheel', stop, { once: true, passive: true });
  win.addEventListener('touchstart', stop, { once: true, passive: true });
  win.addEventListener('keydown', stop, { once: true });
  const release = () => {
    win.removeEventListener('wheel', stop);
    win.removeEventListener('touchstart', stop);
    win.removeEventListener('keydown', stop);
  };
  return new Promise<void>((resolve) => {
    const step = (now: number) => {
      if (motion.cancelled) {
        release();
        resolve();
        return;
      }
      const t = Math.min(1, (now - started) / duration);
      const k = cameraProgress(t, distance);
      path.nodes.forEach((node, i) => {
        const start = path.from[i]!;
        writeScroll(node, start + ((path.to[i] || 0) - start) * k);
      });
      onFrame?.(t);
      if (t < 1) win.requestAnimationFrame(step);
      else {
        finish();
        release();
        resolve();
      }
    };
    win.requestAnimationFrame(step);
  });
}

export const CUE_CSS = `[data-cmd-f=cue]{position:fixed;inset:0;z-index:2147483646;pointer-events:none}
[data-cmd-f=plate]{position:fixed;top:0;left:0;border-radius:8px;background:transparent;box-shadow:0 0 0 3px #3d5a4c,0 0 0 6px #f3f0e8;opacity:0;will-change:transform,opacity}
[data-cmd-f=caption]{position:fixed;top:0;left:0;padding:7px 12px;border-radius:999px;background:rgba(61,90,76,.32);color:rgba(243,240,232,.9);font:600 12px/1.2 ui-sans-serif,system-ui,sans-serif;letter-spacing:.01em;white-space:nowrap;box-shadow:0 0 0 1px rgba(243,240,232,.4);backdrop-filter:blur(10px) saturate(160%);-webkit-backdrop-filter:blur(10px) saturate(160%);opacity:0;will-change:transform,opacity}
@media (prefers-reduced-motion:reduce){
[data-cmd-f=plate],[data-cmd-f=caption]{transition:none}
}`;

export function mountCue(doc: Document) {
  if (!doc.querySelector('[data-cmd-f=cue-style]')) {
    const style = doc.createElement('style');
    style.dataset.cmdF = 'cue-style';
    style.textContent = CUE_CSS;
    doc.documentElement.append(style);
  }
  const root = doc.createElement('div');
  root.dataset.cmdF = 'cue';
  root.innerHTML = '<div data-cmd-f="plate"></div><div data-cmd-f="caption">Source</div>';
  doc.documentElement.append(root);
  return root;
}

export function placeCue(root: HTMLElement, box: Box) {
  const plate = root.querySelector('[data-cmd-f=plate]') as HTMLElement | null;
  const caption = root.querySelector('[data-cmd-f=caption]') as HTMLElement | null;
  const mark = markLayout(box);
  if (plate) {
    plate.style.width = `${mark.plate.width}px`;
    plate.style.height = `${mark.plate.height}px`;
    plate.style.transform = mark.plate.transform;
  }
  if (caption) caption.style.transform = mark.chip.transform;
}

export function playCue(root: HTMLElement, box: () => Box, motion: { cancelled: boolean }) {
  const plate = root.querySelector('[data-cmd-f=plate]') as HTMLElement | null;
  const caption = root.querySelector('[data-cmd-f=caption]') as HTMLElement | null;
  const win = root.ownerDocument.defaultView;
  const paint = (opacity: number) => {
    placeCue(root, box());
    if (plate) plate.style.opacity = String(opacity);
    if (caption) caption.style.opacity = String(opacity);
  };
  const follow = () => {
    if (!root.isConnected) return;
    placeCue(root, box());
  };
  const stopFollow = () => {
    win?.removeEventListener('scroll', follow, true);
    win?.removeEventListener('resize', follow);
  };
  win?.addEventListener('scroll', follow, { capture: true, passive: true });
  win?.addEventListener('resize', follow);
  const idle = {
    track(t = 1) {
      paint(t >= 1 ? 1 : Math.max(0, (t - 0.28) / 0.45));
    },
    settle() {
      paint(1);
    },
    stop() {
      stopFollow();
    },
  };
  if (!plate || !win || prefersReducedMotion(win)) {
    idle.settle();
    return idle;
  }
  return {
    track(t: number) {
      if (!root.isConnected) return;
      idle.track(t);
    },
    settle() {
      if (!root.isConnected) return;
      paint(1);
    },
    stop() {
      stopFollow();
    },
  };
}

import {
  hash,
  normalize,
  type Candidate,
  type PageSnapshot,
  type LocalMessage,
} from '../../contracts/src';
import { shareableUrl, actionPolicy, redact } from '../../security/src';
import { rank } from '../../retrieval/src';
import { semanticPassage, genericText, textBoundary, interactiveText } from './text-elements';
const excluded =
  'script,style,noscript,template,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[data-cmd-f]';
export function safeText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll(excluded + ',[hidden],[aria-hidden="true"]').forEach((e) => e.remove());
  return el.tagName === 'PRE'
    ? (clone.textContent || '').trim()
    : normalize(clone.textContent || '');
}
// Mirror safeText's whitespace normalization while retaining exact DOM offsets,
// including inline links, emphasis and citation nodes.
export function excerptRange(
  el: Element,
  text: string,
  span: { start: number; end: number },
): Range {
  if (
    !Number.isInteger(span.start) ||
    !Number.isInteger(span.end) ||
    span.start < 0 ||
    span.end <= span.start ||
    span.end > text.length
  )
    throw new Error('Invalid excerpt. Search this page again.');
  const walker = el.ownerDocument.createTreeWalker(el, 4);
  const points: { node: Text; offset: number }[] = [];
  let normalized = '';
  let pending: { node: Text; offset: number } | undefined;
  const pre = el.tagName === 'PRE';
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest(excluded + ',[hidden],[aria-hidden="true"]')) continue;
    for (let offset = 0; offset < node.data.length; offset++) {
      const char = node.data[offset];
      if (!pre && /\s/.test(char)) {
        if (normalized && !pending) pending = { node, offset };
        continue;
      }
      if (pending) {
        normalized += ' ';
        points.push(pending);
        pending = undefined;
      }
      normalized += char;
      points.push({ node, offset });
    }
  }
  if (pre) {
    const leading = normalized.length - normalized.trimStart().length;
    normalized = normalized.trim();
    points.splice(0, leading);
    points.length = normalized.length;
  }
  if (normalized !== text) throw new Error('The source text changed. Search this page again.');
  const first = points[span.start];
  const last = points[span.end - 1];
  const range = el.ownerDocument.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}
function accessibleName(el: Element, root: Document | ShadowRoot, text: string): string {
  return (
    el.getAttribute('aria-label') ||
    el
      .getAttribute('aria-labelledby')
      ?.split(/\s+/)
      .map((id) => root.getElementById(id))
      .filter((label): label is HTMLElement => !!label && !label.closest(excluded))
      .map(safeText)
      .join(' ') ||
    text
  );
}
type LocalAnchor = {
  root: Document | ShadowRoot;
  tag: string;
  unique: boolean;
  content: string;
  href: string | null;
};
function visibility(el: Element): Candidate['visibility'] {
  const win = el.ownerDocument.defaultView!;
  let n: Element | null = el;
  while (n) {
    const s = win.getComputedStyle(n);
    if (
      n.hasAttribute('hidden') ||
      n.getAttribute('aria-hidden') === 'true' ||
      s.display === 'none' ||
      s.visibility === 'hidden'
    )
      return 'hidden';
    if (n.tagName === 'DETAILS' && !n.hasAttribute('open') && el !== n.querySelector('summary'))
      return 'hidden';
    n = n.parentElement;
  }
  const rect = el.getBoundingClientRect();
  return rect.bottom < 0 || rect.top > win.innerHeight ? 'offscreen' : 'visible';
}
export class DomSession {
  readonly documentId = crypto.randomUUID();
  version = 0;
  private url: string;
  private observer: MutationObserver;
  private dirty = false;
  private snapshot?: PageSnapshot;
  private nodes = new Map<string, Element>();
  private all: Candidate[] = [];
  private delivered = new Set<string>();
  private anchors = new Map<string, LocalAnchor>();
  private sections = new Map<string, Candidate[]>();
  private outline?: HTMLElement;
  private cleanups: Array<() => void> = [];
  constructor(private doc: Document) {
    this.url = doc.URL;
    this.observer = new MutationObserver((records) => {
      if (
        records.some(
          (r) =>
            !(r.target instanceof Element ? r.target : r.target.parentElement)?.closest(
              '[data-cmd-f]',
            ),
        )
      )
        this.dirty = true;
    });
  }
  stop() {
    this.observer.disconnect();
  }
  clear() {
    this.cleanups.splice(0).forEach((clean) => clean());
    this.doc.querySelectorAll('[data-cmd-f]:not([data-cmd-f=overlay])').forEach((x) => x.remove());
    const css = this.doc.defaultView?.CSS as typeof CSS & { highlights?: Map<string, unknown> };
    css?.highlights?.delete('cmd-f-match');
    this.outline = undefined;
  }
  inspect(question = '', sectionIds?: string[]): PageSnapshot {
    this.observer.disconnect();
    this.clear();
    if (this.dirty || this.doc.URL !== this.url) {
      this.version++;
      this.dirty = false;
      this.url = this.doc.URL;
    }
    const id = crypto.randomUUID();
    this.nodes.clear();
    this.anchors.clear();
    this.sections.clear();
    this.all = [];
    this.delivered.clear();
    const limitations = new Set<string>();
    let headingPath: string[] = [];
    let headingId: string | undefined;
    let sectionId = 's0';
    let count = 0;
    let traversalComplete = true;
    const start = performance.now();
    const controllerByContainer = new Map<string, string>();
    const elementIds = new Map<Element, string>();
    const pendingParents = new Map<string, Element>();
    const passageOwners = new Set<Element>();
    const roots: Array<Document | ShadowRoot> = [this.doc];
    for (let ri = 0; ri < roots.length; ri++) {
      const root = roots[ri];
      const elements = root.querySelectorAll('*');
      for (const el of elements) {
        if (++count > 16000 || performance.now() - start > 500) {
          limitations.add('snapshot_truncated');
          traversalComplete = false;
          break;
        }
        if (
          el.closest(excluded) &&
          !el.matches('input[type=button],input[type=submit],input[type=reset]')
        )
          continue;
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (el.tagName === 'IFRAME') {
          try {
            const frame = el as HTMLIFrameElement;
            if (frame.contentDocument?.body) roots.push(frame.contentDocument);
            else limitations.add('frame_inaccessible');
          } catch {
            limitations.add('frame_inaccessible');
          }
        }
        if (el.tagName === 'CANVAS') limitations.add('canvas_unsupported');
        if (el.tagName === 'EMBED' || el.tagName === 'OBJECT') limitations.add('media_unsupported');
        if (el.tagName.includes('-') && !el.shadowRoot) limitations.add('closed_shadow_possible');
        const tag = el.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag) && visibility(el) !== 'hidden') {
          const h = redact(safeText(el)).slice(0, 300);
          headingPath = headingPath.slice(0, Number(tag[1]) - 1);
          headingPath.push(h);
          headingId = el.id || undefined;
          sectionId = `s${this.sections.size + 1}`;
          if (this.sections.size < 400) this.sections.set(sectionId, []);
        }
        const interactive = el.matches(
          'a[href],button,summary,[role="button"],[role="tab"],[role="menuitem"],input[type="button"],input[type="submit"],input[type="reset"]',
        );
        const semanticBlock = el.matches(semanticPassage);
        const textBlock =
          el.matches(genericText) &&
          !el.closest(interactiveText) &&
          !el.querySelector(textBoundary + ',' + interactiveText);
        if (!interactive && !semanticBlock && !textBlock) continue;
        if (!interactive) {
          let parent = el.parentElement;
          while (parent && !passageOwners.has(parent)) parent = parent.parentElement;
          if (parent) continue;
        }
        const text = tag === 'input' ? '' : safeText(el);
        const name = accessibleName(el, root, text);
        if (!name) {
          if (interactive) limitations.add('missing_accessible_label');
          continue;
        }
        if (redact(name) !== name || redact(text) !== text) {
          limitations.add('redacted_content');
          continue;
        }
        const vis = visibility(el);
        if (!interactive && vis === 'hidden') continue;
        const kind = tag === 'a' ? 'link' : interactive ? 'control' : 'passage';
        const safeUrl =
          tag === 'a' ? shareableUrl(el.getAttribute('href') || '', el.baseURI) : undefined;
        const candidate: Candidate = {
          id: `c${this.all.length}`,
          snapshotId: id,
          kind,
          label: name.slice(0, 500),
          text: kind !== 'control' ? text.slice(0, 9000) : undefined,
          safeUrl,
          headingPath: [...headingPath],
          headingId,
          context: el.closest('[role=doc-bibliography],.reflist,.references')
            ? 'References'
            : el.closest('nav,[role=navigation]')
              ? 'Navigation'
              : el.closest('footer,[role=contentinfo]')
                ? 'Footer'
                : '',
          visibility: vis,
          actionPolicy:
            kind === 'control'
              ? 'highlight_only'
              : kind === 'link'
                ? safeUrl
                  ? actionPolicy(safeUrl)
                  : 'highlight_only'
                : 'read_candidate',
          provenance: 'live_dom',
          textRole: kind === 'passage' ? (/^h[1-6]$/.test(tag) ? 'heading' : 'body') : undefined,
          contentHash: hash(text || name),
          truncated: kind === 'passage' && text.length > 9000,
          sectionId,
          disabled: el.matches(':disabled,[aria-disabled=true]'),
          expanded: el.hasAttribute('aria-expanded')
            ? el.getAttribute('aria-expanded') === 'true'
            : tag === 'summary'
              ? el.parentElement?.hasAttribute('open')
              : undefined,
        };
        if (text.length > 9000) limitations.add('passage_truncated');
        if (candidate.kind === 'link' && candidate.actionPolicy !== 'read_candidate')
          candidate.kind = 'control';
        if (kind === 'passage') passageOwners.add(el);
        this.all.push(candidate);
        this.nodes.set(candidate.id, el);
        this.anchors.set(candidate.id, {
          root,
          tag: el.tagName,
          unique: false,
          content: text || name,
          href: tag === 'a' ? el.getAttribute('href') : null,
        });
        elementIds.set(el, candidate.id);
        if (!this.sections.has(sectionId) && this.sections.size < 400)
          this.sections.set(sectionId, []);
        this.sections.get(sectionId)?.push(candidate);
        if (el.hasAttribute('aria-controls'))
          controllerByContainer.set(el.getAttribute('aria-controls')!, candidate.id);
        pendingParents.set(candidate.id, el);
      }
    }
    // A duplicate quote must not silently relocate to a different occurrence if
    // the original disappears. Require uniqueness both before and after re-render.
    const identities = new Map<Document | ShadowRoot, Map<string, number>>();
    const identity = (anchor: LocalAnchor) =>
      JSON.stringify([anchor.tag, anchor.content, anchor.href]);
    for (const anchor of this.anchors.values()) {
      let counts = identities.get(anchor.root);
      if (!counts) identities.set(anchor.root, (counts = new Map()));
      const key = identity(anchor);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const anchor of this.anchors.values())
      anchor.unique = identities.get(anchor.root)?.get(identity(anchor)) === 1;
    for (const c of this.all) {
      let el = pendingParents.get(c.id)?.parentElement;
      while (el) {
        const ctrl =
          controllerByContainer.get(el.id) ||
          (el.tagName === 'DETAILS' ? elementIds.get(el.querySelector('summary')!) : undefined);
        if (ctrl) {
          c.parentControlId = ctrl;
          break;
        }
        el = el.parentElement;
      }
    }
    let choices: Candidate[];
    if (sectionIds) {
      const wanted = new Set(sectionIds);
      choices = this.all.filter((c) => wanted.has(c.sectionId || ''));
    } else {
      const passages = this.all.filter((c) => c.kind === 'passage');
      choices = [
        ...rank(question, passages).map((x) => x.candidate),
        ...this.all.filter((c) => c.kind !== 'passage'),
      ];
      if (!question) choices = this.all;
    }
    const selected: Candidate[] = [];
    let bytes = 0;
    // Reserve room for navigation and catalog, including late-page sections.
    const navigation = rank(
      question,
      choices.filter((c) => c.kind !== 'passage'),
    )
      .sort(
        (a, b) =>
          Number(a.candidate.visibility === 'hidden') - Number(b.candidate.visibility === 'hidden'),
      )
      .map(({ candidate }) => candidate);
    for (const c of navigation.slice(0, 120)) {
      const size = new TextEncoder().encode(JSON.stringify(c)).byteLength;
      if (bytes + size > 25000) break;
      selected.push(c);
      bytes += size;
    }
    for (const c of choices.filter((c) => c.kind === 'passage')) {
      const size = new TextEncoder().encode(JSON.stringify(c)).byteLength;
      if (bytes + size > 55000 || selected.length >= 350) continue;
      selected.push(c);
      bytes += size;
    }
    selected.forEach((c) => this.delivered.add(c.id));
    if (selected.length < this.all.length) {
      limitations.add('snapshot_truncated');
      for (const group of this.remainingGroups(id, question)) {
        const size = new TextEncoder().encode(JSON.stringify(group)).byteLength;
        if (bytes + size > 76000 || selected.length >= 590) break;
        bytes += size;
        selected.push(group);
      }
    }
    this.snapshot = {
      id,
      documentId: this.documentId,
      version: this.version,
      url: shareableUrl(this.doc.URL),
      origin: this.doc.location.origin,
      title: redact(this.doc.title).slice(0, 300),
      observedAt: new Date().toISOString(),
      candidates: selected,
      limitations: [...limitations],
      sectionIds: [...this.sections.keys()],
      private: true,
      discovery: {
        candidates: this.all.filter((c) => c.textRole !== 'heading' && c.visibility !== 'hidden')
          .length,
        links: this.all.filter((c) => c.kind === 'link' && c.visibility !== 'hidden').length,
        complete: traversalComplete,
      },
    };
    this.observer.observe(this.doc, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['hidden', 'style', 'class', 'aria-expanded', 'aria-hidden', 'disabled'],
    });
    return this.snapshot;
  }
  private remainingGroups(snapshotId: string, question = ''): Candidate[] {
    const groups: Candidate[] = [];
    for (const [sid, cs] of this.sections) {
      const omitted = cs.filter((c) => !this.delivered.has(c.id) && c.visibility !== 'hidden');
      if (!omitted.length) continue;
      const c = rank(question, omitted)[0].candidate;
      groups.push({
        ...c,
        snapshotId,
        id: `g${sid}`,
        kind: 'group',
        label: c.headingPath.at(-1) || 'Page section',
        text: undefined,
        context: (c.text || c.label).slice(0, 120),
        sectionId: sid,
      });
    }
    return groups;
  }
  readSections(snapshotId: string, ids: string[]) {
    if (
      this.dirty ||
      this.doc.URL !== this.url ||
      this.snapshot?.id !== snapshotId ||
      ids.some((id) => !this.sections.has(id))
    )
      throw new Error('Source changed. Inspect the page again.');
    // Page through the immutable extraction, retaining the node identities used by SHOW.
    // Re-extracting used to return the same first window on every section request.
    const wanted = new Set(ids);
    const selected: Candidate[] = [];
    let bytes = 0;
    for (const c of this.all) {
      if (!wanted.has(c.sectionId || '') || this.delivered.has(c.id) || c.visibility === 'hidden')
        continue;
      const size = new TextEncoder().encode(JSON.stringify(c)).byteLength;
      if (bytes + size > 55000 || selected.length >= 350) continue;
      bytes += size;
      selected.push(c);
      this.delivered.add(c.id);
    }
    for (const group of this.remainingGroups(snapshotId)) {
      const size = new TextEncoder().encode(JSON.stringify(group)).byteLength;
      if (bytes + size > 76000 || selected.length >= 590) break;
      selected.push(group);
      bytes += size;
    }
    this.snapshot = { ...this.snapshot, candidates: selected };
    return this.snapshot;
  }
  show(
    snapshotId: string,
    candidateId: string,
    documentId: string,
    excerpt?: { start: number; end: number },
  ) {
    if (
      this.doc.URL !== this.url ||
      this.snapshot?.id !== snapshotId ||
      this.documentId !== documentId
    )
      throw new Error('Source changed. Search this page again.');
    const c = this.all.find((x) => x.id === candidateId);
    const anchor = this.anchors.get(candidateId);
    let el = this.nodes.get(candidateId);
    if (!c || !anchor || !el)
      throw new Error('This result is no longer available. Search this page again.');
    const matches = (node: Element) => {
      if (node.tagName !== anchor.tag || node.closest(excluded)) return false;
      const text = node.tagName === 'INPUT' ? '' : safeText(node);
      return (
        (text || accessibleName(node, anchor.root, text)) === anchor.content &&
        (node.tagName !== 'A' || node.getAttribute('href') === anchor.href)
      );
    };
    const available = (node: Element) =>
      node.isConnected &&
      visibility(node) !== 'hidden' &&
      !node.matches(':disabled,[aria-disabled=true]');
    if (!el.isConnected) {
      // Re-rendered nodes may have new identities. Recover only an exact, unambiguous
      // match in the original document/shadow root; never guess from a fuzzy quote.
      const matchesFound: Element[] = [];
      const start = performance.now();
      let count = 0;
      for (const node of anchor.root.querySelectorAll(anchor.tag.toLowerCase())) {
        if (++count > 16000 || performance.now() - start > 500)
          throw new Error('The page changed too much to locate this result. Search again.');
        if (matches(node) && available(node)) matchesFound.push(node);
      }
      if (!anchor.unique || matchesFound.length !== 1)
        throw new Error(
          'The original passage moved or changed and could not be located reliably. Search this page again.',
        );
      el = matchesFound[0];
      this.nodes.set(candidateId, el);
    }
    if (!available(el))
      throw new Error(
        'This target is hidden or unavailable. Open its menu, then try Show on page again.',
      );
    if (!matches(el)) throw new Error('The source text or link changed. Search this page again.');
    const focusedRange =
      excerpt && c.kind === 'passage' ? excerptRange(el, c.text || c.label, excerpt) : undefined;
    this.observer.disconnect();
    this.clear();
    const d = el.ownerDocument;
    const css = d.defaultView?.CSS as typeof CSS & { highlights?: Map<string, unknown> };
    const H = (d.defaultView as unknown as { Highlight?: new (...ranges: Range[]) => unknown })
      .Highlight;
    const textHighlight = c.kind === 'passage' && !!css?.highlights && !!H;
    let style: HTMLStyleElement | undefined;
    if (textHighlight) {
      style = d.createElement('style');
      style.dataset.cmdF = 'style';
      style.textContent = '::highlight(cmd-f-match){background:#f6e6a4;color:#222}';
      d.documentElement.append(style);
      const range = focusedRange || d.createRange();
      if (!focusedRange) range.selectNodeContents(el);
      css.highlights.set('cmd-f-match', new H(range));
    }
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (focusedRange) {
      const target = focusedRange.startContainer.parentElement;
      target?.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    let overlay: HTMLElement | undefined;
    const update = () => {
      if (!overlay) return;
      if (!el.isConnected) {
        overlay.remove();
        return;
      }
      const r = focusedRange?.getBoundingClientRect() || el.getBoundingClientRect();
      Object.assign(overlay.style, {
        left: `${r.left - 4}px`,
        top: `${r.top - 4}px`,
        width: `${r.width + 8}px`,
        height: `${r.height + 8}px`,
      });
    };
    if (!textHighlight) {
      overlay = d.createElement('div');
      overlay.dataset.cmdF = 'outline';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.cssText =
        'position:fixed;pointer-events:none;border:2px solid #b49b42;border-radius:5px;background:#d2b85814;z-index:2147483647;';
      d.documentElement.append(overlay);
      this.outline = overlay;
      update();
      d.defaultView?.addEventListener('scroll', update, { passive: true });
      d.defaultView?.addEventListener('resize', update);
    }
    this.cleanups.push(() => {
      overlay?.remove();
      style?.remove();
      css?.highlights?.delete('cmd-f-match');
      d.defaultView?.removeEventListener('scroll', update);
      d.defaultView?.removeEventListener('resize', update);
    });
    this.observer.observe(this.doc, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['hidden', 'style', 'class', 'aria-expanded', 'aria-hidden', 'disabled'],
    });
    return { ok: true };
  }
  handle(msg: LocalMessage) {
    switch (msg.type) {
      case 'INSPECT':
        return this.inspect(msg.question);
      case 'READ_SECTION':
        return this.readSections(msg.snapshotId, msg.sectionIds);
      case 'SHOW':
        return this.show(msg.snapshotId, msg.candidateId, msg.documentId, msg.excerpt);
      case 'CLEAR':
        this.clear();
        return { ok: true };
      case 'STOP':
        this.stop();
        return { ok: true };
    }
  }
}

import { load } from 'cheerio';
import { semanticPassage, genericText, textBoundary, interactiveText } from './text-elements';
import { randomUUID } from 'node:crypto';
import { hash, normalize, type Candidate, type PageSnapshot } from '../../contracts/src';
import { shareableUrl, actionPolicy, redact } from '../../security/src';
export function extractHtml(html: string, url: string, _question = ''): PageSnapshot {
  const $ = load(html);
  const id = randomUUID();
  const candidates: Candidate[] = [];
  const limitations: string[] = [];
  let headingPath: string[] = [];
  let headingId: string | undefined;
  if ($('input[type=password]').length) limitations.push('login_required');
  $(
    'script,style,noscript,template,textarea,input,select,[contenteditable]:not([contenteditable=false]),[hidden],[aria-hidden=true]',
  ).remove();
  const base = shareableUrl($('base').attr('href') || url, url) || url;
  const passageOwners = new Set<object>();
  $(semanticPassage + ',' + genericText + ',' + interactiveText).each((index, el) => {
    if (index >= 16000) {
      limitations.push('snapshot_truncated');
      return false;
    }
    if (!('tagName' in el)) return;
    const node = $(el);
    const interactive = node.is(interactiveText);
    if (!interactive) {
      if (
        node
          .parents()
          .toArray()
          .some((parent) => passageOwners.has(parent))
      )
        return;
      if (
        !node.is(semanticPassage) &&
        (node.closest(interactiveText).length ||
          node.find(textBoundary + ',' + interactiveText).length)
      )
        return;
    }
    const raw = el.tagName === 'pre' ? node.text().trim() : normalize(node.text());
    if (!raw) return;
    if (raw.length > 9000 && !limitations.includes('passage_truncated'))
      limitations.push('passage_truncated');
    const text = redact(raw);
    if (text !== raw) {
      if (!limitations.includes('redacted_content')) limitations.push('redacted_content');
      return;
    }
    if (/^h[1-6]$/.test(el.tagName)) {
      const level = Number(el.tagName[1]);
      headingPath = headingPath.slice(0, level - 1);
      headingPath[level - 1] = text.slice(0, 300);
      headingPath = headingPath.filter(Boolean);
      headingId = node.attr('id');
    }
    const kind = el.tagName === 'a' ? 'link' : interactive ? 'control' : 'passage';
    const safeUrl = kind === 'link' ? shareableUrl(node.attr('href') || '', base) : undefined;
    const policy =
      kind === 'control'
        ? 'highlight_only'
        : kind === 'link'
          ? safeUrl
            ? actionPolicy(safeUrl)
            : 'highlight_only'
          : 'read_candidate';
    if (kind === 'passage') passageOwners.add(el);
    candidates.push({
      id: `c${candidates.length}`,
      snapshotId: id,
      kind,
      label: text.slice(0, 300),
      text: kind !== 'control' ? text.slice(0, 9000) : undefined,
      safeUrl,
      headingPath: [...headingPath],
      headingId,
      context: node.closest('[role=doc-bibliography],.reflist,.references').length
        ? 'References'
        : node.closest('nav,[role=navigation]').length
          ? 'Navigation'
          : node.closest('footer,[role=contentinfo]').length
            ? 'Footer'
            : '',
      visibility: kind === 'control' ? 'unknown' : 'visible',
      actionPolicy: policy,
      provenance: 'html',
      textRole: kind === 'passage' ? (/^h[1-6]$/.test(el.tagName) ? 'heading' : 'body') : undefined,
      contentHash: hash(text),
      truncated: kind === 'passage' && text.length > 9000,
      disabled: node.attr('disabled') !== undefined,
    });
  });
  if (
    candidates.filter((c) => c.kind === 'passage').reduce((n, c) => n + (c.text?.length || 0), 0) <
    80
  )
    limitations.push('rendering_needed');
  return {
    id,
    documentId: id,
    version: 0,
    url: shareableUrl(url),
    origin: new URL(url).origin,
    title: normalize($('title').text()).slice(0, 300),
    observedAt: new Date().toISOString(),
    candidates,
    limitations,
    sectionIds: [],
    private: false,
  };
}

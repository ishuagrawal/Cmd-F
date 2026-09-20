import { passageUrl } from '../source-link';
import { DomSession } from '../../../../packages/extraction/src/dom';
import {
  SnapshotSchema,
  type LocalMessage,
  type PageSnapshot,
} from '../../../../packages/contracts/src';
export const isExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
let demoSession: DomSession | undefined;
let demoDocument: Document | undefined;
export async function source() {
  if (isExtension) {
    const res = await chrome.runtime.sendMessage({ type: 'SOURCE' });
    if (res.error) throw new Error(res.error);
    return res as { tabId: number; url?: string; title?: string; viewportHeight?: number };
  }
  const frame = document.querySelector<HTMLIFrameElement>('#fixture');
  return {
    tabId: 0,
    url: frame?.contentDocument?.URL,
    title: frame?.contentDocument?.title,
    viewportHeight: innerHeight,
  };
}
export async function local(tabId: number, operation: LocalMessage): Promise<unknown> {
  if (isExtension) {
    const response = await chrome.runtime.sendMessage({ tabId, operation });
    if (response?.error) throw new Error(response.error);
    return response;
  }
  const doc = document.querySelector<HTMLIFrameElement>('#fixture')?.contentDocument;
  if (!doc?.body) throw new Error('The fixture is still loading. Try again.');
  if (doc !== demoDocument) {
    demoSession?.stop();
    demoSession = new DomSession(doc);
    demoDocument = doc;
  }
  return demoSession!.handle(operation);
}
export async function inspect(tabId: number, question = ''): Promise<PageSnapshot> {
  return SnapshotSchema.parse(await local(tabId, { type: 'INSPECT', question }));
}
export async function openSource(url: string, quote?: string) {
  if (isExtension) {
    const result = await chrome.runtime.sendMessage({ type: 'OPEN_SOURCE', url, quote });
    if (result?.error) throw new Error(result.error);
  } else window.open(passageUrl(url, quote), '_blank', 'noopener,noreferrer');
}

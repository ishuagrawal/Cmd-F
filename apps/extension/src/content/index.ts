import { DomSession } from '../../../../packages/extraction/src/dom';
import { LocalMessageSchema } from '../../../../packages/contracts/src';
const root = globalThis as typeof globalThis & { __cmdF?: DomSession };
if (!root.__cmdF) {
  const session = new DomSession(document);
  root.__cmdF = session;
  chrome.runtime.onMessage.addListener((raw, sender, respond) => {
    if (
      sender.id !== chrome.runtime.id ||
      (!sender.url?.startsWith(chrome.runtime.getURL('sidepanel.html')) &&
        !sender.url?.startsWith(chrome.runtime.getURL('background.js')))
    )
      return;
    const parsed = LocalMessageSchema.safeParse(raw);
    if (!parsed.success) {
      respond({ error: 'Invalid operation' });
      return;
    }
    try {
      respond(session.handle(parsed.data));
    } catch (error) {
      respond({ error: error instanceof Error ? error.message : 'Inspection failed' });
    }
    return false;
  });
}

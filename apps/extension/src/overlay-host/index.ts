// This isolated-world script runs only after the user invokes the extension.
const globals = globalThis as typeof globalThis & {
  __cmdFOverlay?: () => void;
  __cmdFOverlayAlive?: () => boolean;
};
if (globals.__cmdFOverlay && globals.__cmdFOverlayAlive?.()) {
  globals.__cmdFOverlay();
} else {
  document.querySelectorAll('[data-cmd-f="overlay"]').forEach((node) => node.remove());
  const runtime = chrome.runtime;
  globals.__cmdFOverlayAlive = () => {
    try {
      return !!runtime.id;
    } catch {
      return false;
    }
  };
  let host: HTMLDivElement | undefined;
  let previous: HTMLElement | null = null;
  const close = () => {
    host?.remove();
    host = undefined;
    previous?.focus({ preventScroll: true });
  };
  const toggle = () => {
    if (host?.isConnected) {
      close();
      return;
    }
    previous = document.activeElement as HTMLElement | null;
    host = document.createElement('div');
    host.dataset.cmdF = 'overlay';
    host.style.cssText =
      'all:initial!important;position:fixed!important;top:16px!important;right:16px!important;width:min(440px,calc(100vw - 32px))!important;height:74px!important;z-index:2147483647!important;display:block!important;color-scheme:light!important;';
    const shadow = host.attachShadow({ mode: 'open' });
    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('overlay.html');
    frame.title = 'Cmd-F chat';
    frame.style.cssText =
      'display:block;width:100%;height:100%;border:0;background:transparent;color-scheme:normal;';
    shadow.append(frame);
    document.documentElement.append(host);
    frame.addEventListener('load', () => frame.contentWindow?.focus(), { once: true });
  };
  globals.__cmdFOverlay = toggle;
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('background.js'))
      return;
    if (message?.type === 'CLOSE_OVERLAY') {
      close();
      respond({ ok: true });
    }
    if (message?.type === 'RESIZE_OVERLAY' && host && typeof message.height === 'number') {
      host.style.setProperty(
        'height',
        `${Math.min(innerHeight - 32, Math.max(74, message.height))}px`,
        'important',
      );
      respond({ ok: true });
    }
  });
  toggle();
}

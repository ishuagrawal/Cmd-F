import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Chat } from '../overlay/main';
import { isolateOverlayEvents } from '../overlay/focus';

declare const __OVERLAY_CSS__: string;

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
  let reactRoot: Root | undefined;
  let previous: HTMLElement | null = null;
  const close = () => {
    reactRoot?.unmount();
    reactRoot = undefined;
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
      'all:initial!important;position:fixed!important;top:16px!important;right:16px!important;width:min(440px,calc(100vw - 32px))!important;z-index:2147483647!important;display:block!important;background:transparent!important;';
    const shadow = host.attachShadow({ mode: 'open' });
    isolateOverlayEvents(shadow);
    const style = document.createElement('style');
    style.textContent = __OVERLAY_CSS__;
    const root = document.createElement('div');
    shadow.append(style, root);
    document.documentElement.append(host);
    reactRoot = createRoot(root);
    reactRoot.render(createElement(Chat));
  };
  globals.__cmdFOverlay = toggle;
  window.addEventListener('cmd-f-reconnect', () => {
    if (!globals.__cmdFOverlayAlive?.()) return;
    close();
    toggle();
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('background.js'))
      return;
    if (message?.type === 'CLOSE_OVERLAY') {
      close();
      respond({ ok: true });
    }
  });
  toggle();
}

import { expect, it, vi } from 'vitest';
import { isolateOverlayEvents, pageHoldsFocus } from '../../apps/extension/src/overlay/focus';

const overlayWith = (held: unknown, host: unknown = { id: 'host' }) => ({
  contains: (node: unknown) => node === held,
  getRootNode: () => ({ host }),
});

it('treats a page search field as holding focus', () => {
  const field = { id: 'page-search' };
  expect(pageHoldsFocus(field, overlayWith({ id: 'request' }))).toBe(true);
});

it('does not treat the overlay request field as a page control', () => {
  const field = { id: 'request' };
  expect(pageHoldsFocus(field, overlayWith(field))).toBe(false);
});

it('does not treat the overlay shadow host as a page control', () => {
  const host = { id: 'host' };
  expect(pageHoldsFocus(host, overlayWith({ id: 'request' }, host))).toBe(false);
});

it('does not treat an empty document as a page control', () => {
  expect(pageHoldsFocus(null, overlayWith({ id: 'request' }))).toBe(false);
});

it('stops overlay key events from propagating', () => {
  const root = new EventTarget();
  isolateOverlayEvents(root);
  const event = new Event('keydown', { bubbles: true });
  const stop = vi.spyOn(event, 'stopPropagation');
  root.dispatchEvent(event);
  expect(stop).toHaveBeenCalled();
});

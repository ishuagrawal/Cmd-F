import { expect, it } from 'vitest';
import { launchFailure } from '../../apps/extension/src/background/launch-error';
it.each([
  'chrome://newtab/',
  'chrome://extensions/',
  'chrome-extension://abc/index.html',
  'https://chromewebstore.google.com/detail/example',
  'https://chrome.google.com/webstore/detail/example',
])('identifies protected tab %s', (url) => {
  expect(launchFailure(url, new Error('Cannot inject'))).toBe('restricted');
});
it('does not label a broken installation as a restricted website', () => {
  expect(
    launchFailure('https://example.com', new Error('Could not load file: overlay-host.js')),
  ).toBe('installation');
});
it('distinguishes missing permission from a page restriction', () => {
  expect(
    launchFailure(
      'https://example.com',
      new Error('Cannot access contents of the page. Extension manifest must request permission'),
    ),
  ).toBe('permission');
});

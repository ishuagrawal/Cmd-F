import { expect, it, vi } from 'vitest';
import { alignReply } from '../../apps/extension/src/overlay/scroll';

it('scrolls the log so the reply starts at the top of the pane', () => {
  const scroller = {
    scrollTop: 400,
    getBoundingClientRect: () => ({ top: 100 }),
    scrollTo: vi.fn(),
  };
  const reply = { getBoundingClientRect: () => ({ top: 300 }) };
  alignReply(scroller, reply);
  expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 600, behavior: 'instant' });
});

it('starts at the first result card so the coverage row and its divider sit above the fold', () => {
  const scroller = {
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 100 }),
    scrollTo: vi.fn(),
  };
  const card = { getBoundingClientRect: () => ({ top: 340 }) };
  const reply = {
    getBoundingClientRect: () => ({ top: 300 }),
    querySelector: () => card as unknown as Element,
  };
  alignReply(scroller, reply);
  expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 240, behavior: 'instant' });
});

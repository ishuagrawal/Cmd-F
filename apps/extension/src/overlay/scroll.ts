// The coverage stats and the divider they sit above are preamble, so a new
// reply lands on its first result card when one exists.
const answerStart = '.listing-note, .source';

export function alignReply(
  scroller: Pick<HTMLElement, 'scrollTop'> & {
    getBoundingClientRect(): Pick<DOMRect, 'top'>;
    scrollTo(options: ScrollToOptions): void;
  },
  reply: {
    getBoundingClientRect(): Pick<DOMRect, 'top'>;
    querySelector?(selectors: string): Element | null;
  },
) {
  const anchor = reply.querySelector?.(answerStart) || reply;
  const top =
    anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
}

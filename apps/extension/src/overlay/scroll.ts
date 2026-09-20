export function alignReply(
  scroller: Pick<HTMLElement, 'scrollTop'> & {
    getBoundingClientRect(): Pick<DOMRect, 'top'>;
    scrollTo(options: ScrollToOptions): void;
  },
  reply: { getBoundingClientRect(): Pick<DOMRect, 'top'> },
) {
  const top =
    reply.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
}

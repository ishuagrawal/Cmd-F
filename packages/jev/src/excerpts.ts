export interface Excerpt {
  start: number;
  end: number;
}

// Offsets always refer to the immutable source, never generated text. Keep
// citation markers attached to the sentence before them (Wikipedia has no space).
export function excerptOptions(text: string): (Excerpt & { id: string; text: string })[] {
  if (text.length <= 350) return [];
  const sentences: Excerpt[] = [];
  const boundary = /[.!?](?:["'”’])?(?:\[\d+\])*(?=\s|$)/g;
  let start = 0;
  for (const match of text.matchAll(boundary)) {
    const end = match.index! + match[0].length;
    // Avoid common initials/abbreviations and tiny sentence fragments.
    if (
      end - start < 30 ||
      /\b(?:Mr|Mrs|Ms|Dr|Prof|Inc|vs|e\.g|i\.e)\.$/.test(text.slice(start, end))
    )
      continue;
    sentences.push({ start, end });
    start = end;
    while (/\s/.test(text[start] || '') && start < text.length) start++;
  }
  if (start < text.length) sentences.push({ start, end: text.length });
  if (sentences.length < 2) return [];
  const options: (Excerpt & { id: string; text: string })[] = [];
  for (let i = 0; i < sentences.length; i++) {
    for (let count = 1; count <= 3 && i + count <= sentences.length; count++) {
      const span = { start: sentences[i].start, end: sentences[i + count - 1].end };
      if (span.end - span.start > 900) continue;
      options.push({ ...span, id: `s${i}-${count}`, text: text.slice(span.start, span.end) });
    }
  }
  return options;
}

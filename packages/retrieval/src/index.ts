import type { Candidate } from '../../contracts/src';
const stop = new Set(
  'a an the what how is are was were do does did has have had i my me to of in on it can where when for with and this that which please find tell work works'.split(
    ' ',
  ),
);
const synonyms: Record<string, string> = {
  cycles: 'cycle',
  cycling: 'cycle',
  repetition: 'repeat',
  repeated: 'repeat',
  repeating: 'repeat',
  named: 'name',
  called: 'name',
  name: 'name',
};
function stem(term: string) {
  if (synonyms[term]) return synonyms[term];
  if (term.length > 4 && /(?:ied|ies)$/.test(term)) return term.slice(0, -3) + 'y';
  if (term.length > 5 && term.endsWith('ed')) return term.slice(0, -2);
  return term.replace(/s$/, '');
}
export function tokens(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/['’]s\b/g, '')
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((t) => !stop.has(t))
      .map(stem) || []
  );
}
export function rank<
  T extends Pick<Candidate, 'label' | 'text' | 'context' | 'headingPath'> & { safeUrl?: string },
>(question: string, candidates: T[]): Array<{ candidate: T; score: number; overlap: number }> {
  const q = [...new Set(tokens(question))];
  // Keep ordered phrases for routing: removing stop words alone can make
  // similarly worded destinations indistinguishable. This applies to any matching phrase.
  const words = (text: string) =>
    text
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.map(stem) || [];
  const queryWords = words(question);
  const phrases = queryWords
    .slice(0, -1)
    .map((word, i) => [word, queryWords[i + 1]])
    .filter((pair) => pair.some((word) => !stop.has(word)));
  const paths = candidates.map((c) => {
    try {
      if (!c.safeUrl) return '';
      const u = new URL(c.safeUrl);
      return `${u.hostname.replace(/^www\./, '')} ${u.pathname}`;
    } catch {
      return '';
    }
  });
  const docs = candidates.map((c, i) =>
    tokens([c.label, c.text, c.context, ...c.headingPath, paths[i]].join(' ')),
  );
  const avg = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length);
  const frequencies = docs.map((doc) => {
    const freq = new Map<string, number>();
    for (const word of doc) freq.set(word, (freq.get(word) || 0) + 1);
    return freq;
  });
  const documentFrequency = new Map(
    q.map((term) => [term, frequencies.filter((f) => f.has(term)).length]),
  );
  return candidates
    .map((candidate, i) => {
      let score = 0,
        matched = 0;
      for (const term of q) {
        const tf = frequencies[i].get(term) || 0;
        if (!tf) continue;
        matched++;
        const df = documentFrequency.get(term)!;
        score +=
          (Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)) * (tf * 2.2)) /
          (tf + 1.2 * (0.25 + (0.75 * docs[i].length) / Math.max(avg, 1)));
      }
      const titleWords = words(candidate.label + ' ' + paths[i]);
      for (const [first, second] of phrases)
        if (titleWords.some((word, index) => word === first && titleWords[index + 1] === second))
          score += 2;
      const reference =
        candidate.context === 'References' ||
        candidate.headingPath.some((h) =>
          /^(references|citations|bibliography|notes and references)$/i.test(h),
        );
      if (reference && !/\b(references?|citations?|bibliography|sources?)\b/i.test(question))
        score *= 0.1;
      if (candidate.context === 'Footer') score *= 0.2;
      return { candidate, score, overlap: matched / Math.max(1, q.length) };
    })
    .sort((a, b) => b.score - a.score);
}
export function shortlist(question: string, candidates: Candidate[], limit = 40): Candidate[] {
  if (candidates.length <= limit) return candidates;
  const ranked = rank(question, candidates);
  const selected = ranked.slice(0, Math.floor(limit * 0.75)).map((x) => x.candidate);
  const remaining = candidates.filter((c) => !selected.includes(c));
  for (
    let i = 0;
    selected.length < limit && i < remaining.length;
    i += Math.max(1, Math.floor(remaining.length / (limit / 4)))
  )
    selected.push(remaining[i]);
  return selected;
}

// Query relevance stays primary. Page subject and URL locality break ties without
// rewriting the request or hard-coding a site's taxonomy.
export function rankRoutes(
  question: string,
  candidates: Candidate[],
  page: { title: string; url?: string },
) {
  const subject = new Set(tokens(page.title));
  let base: URL | undefined;
  try {
    base = page.url ? new URL(page.url) : undefined;
  } catch {
    /* optional context */
  }
  return rank(question, candidates)
    .map((item) => {
      const label = tokens(item.candidate.label);
      const affinity = label.filter((word) => subject.has(word)).length / Math.max(1, label.length);
      let locality = 0;
      try {
        const dest = new URL(item.candidate.safeUrl!);
        if (base && dest.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '')) {
          const path = dest.pathname.split('/').filter(Boolean);
          const source = base.pathname.split('/').filter(Boolean);
          for (let i = 0; i < Math.min(path.length - 1, source.length - 1); i++) {
            if (path[i] !== source[i]) break;
            locality += 1;
          }
        }
      } catch {
        /* no URL */
      }
      return { ...item, score: item.score * (1 + 0.25 * affinity + 0.1 * Math.min(locality, 3)) };
    })
    .sort((a, b) => b.score - a.score);
}

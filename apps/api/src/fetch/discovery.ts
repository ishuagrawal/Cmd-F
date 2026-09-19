import robotsParser from 'robots-parser';
import { load } from 'cheerio';
import type { SafeFetcher } from './safe-fetch';
export async function loadRobots(fetcher: SafeFetcher, origin: string, signal: AbortSignal) {
  const r = await fetcher.get(`${origin}/robots.txt`, origin, signal, 500000);
  if (r.status === 404 || r.status === 410)
    return { allows: (_url: string) => true, sitemaps: [] as string[], delay: 500 };
  if (r.status !== 200) throw new Error('robots_unreachable');
  const parser = robotsParser(`${origin}/robots.txt`, r.body);
  return {
    allows: (url: string) => parser.isAllowed(url, 'Cmd-F') !== false,
    sitemaps: parser.getSitemaps().slice(0, 10),
    delay: Math.max(500, (parser.getCrawlDelay('Cmd-F') || 0) * 1000),
  };
}
export function sitemapLocations(body: string): string[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(body)) throw new Error('unsafe_xml');
  const $ = load(body, { xml: true });
  return $('loc')
    .slice(0, 5000)
    .map((_, el) => $(el).text().trim())
    .get();
}
export async function discoverSitemaps(
  fetcher: SafeFetcher,
  origin: string,
  seeds: string[],
  allows: (url: string) => boolean,
  signal: AbortSignal,
  budget = { seen: new Set<string>(), bytes: 0 },
): Promise<string[]> {
  const seen = budget.seen;
  const urls: string[] = [];
  const queue = [...seeds];

  while (queue.length && seen.size < 10 && budget.bytes < 10_000_000 && urls.length < 5000) {
    const next = queue.shift()!;
    if (seen.has(next) || !allows(next)) continue;
    seen.add(next);
    try {
      const page = await fetcher.get(
        next,
        origin,
        signal,
        Math.min(2_000_000, 10_000_000 - budget.bytes),
        allows,
      );
      if (page.status !== 200) continue;
      budget.bytes += Buffer.byteLength(page.body);
      const locs = sitemapLocations(page.body);
      if (/<sitemapindex[\s>]/i.test(page.body)) queue.push(...locs.slice(0, 10));
      else urls.push(...locs);
    } catch {
      signal.throwIfAborted();
    }
  }
  return urls.slice(0, 5000);
}

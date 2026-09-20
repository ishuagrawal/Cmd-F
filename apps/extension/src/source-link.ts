// Keep the page's anchor as a fallback if text-fragment navigation is unavailable.
export function passageUrl(url: string, quote?: string): string {
  const text = quote?.replace(/\s+/g, ' ').trim();
  if (!text) return url;
  const target = new URL(url);
  const anchor = target.hash.split(':~:')[0];
  // Hyphens and commas are text-fragment syntax, so encode them in source text.
  const encode = (value: string) =>
    encodeURIComponent(value).replace(
      /[-!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  const words = text.split(' ');
  const fragment =
    text.length > 300 && words.length > 24
      ? `${encode(words.slice(0, 12).join(' '))},${encode(words.slice(-12).join(' '))}`
      : encode(text);
  target.hash = `${anchor}:~:text=${fragment}`;
  return target.href;
}

import './load-env.ts';
export function apiOrigin() {
  const url = new URL(
    process.env.CMD_F_API_BASE_URL || `http://127.0.0.1:${process.env.API_PORT || 4317}`,
  );
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'This release supports an exact loopback API origin only. Hosted identity is not implemented.',
    );
  return url.origin;
}

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { Artifact } from '../fetch/safe-fetch';
export class PublicCache {
  private db: DatabaseSync;
  constructor(
    path = ':memory:',
    private ttl = 900000,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS pages (key TEXT PRIMARY KEY, artifact TEXT NOT NULL, expires INTEGER NOT NULL)',
    );
  }
  private key(url: string) {
    return createHash('sha256').update(`html-v1:anonymous:default-language:${url}`).digest('hex');
  }
  get(url: string): Artifact | undefined {
    const row = this.db
      .prepare('SELECT artifact,expires FROM pages WHERE key=?')
      .get(this.key(url));
    if (!row || Number(row.expires) < Date.now()) return;
    return JSON.parse(String(row.artifact)) as Artifact;
  }
  put(artifact: Artifact) {
    const h = artifact.headers;
    const cc = h['cache-control'] || '';
    if (
      artifact.status !== 200 ||
      /private|no-store|no-cache/i.test(cc) ||
      h['set-cookie'] ||
      h['www-authenticate'] ||
      (h.vary && h.vary !== 'Accept-Encoding')
    )
      return;
    const maxAge = cc.match(/(?:^|,)\s*max-age=(\d+)/i);
    const ttl = Math.min(this.ttl, maxAge ? Number(maxAge[1]) * 1000 : this.ttl);
    if (ttl <= 0) return;
    this.db
      .prepare('INSERT OR REPLACE INTO pages VALUES (?,?,?)')
      .run(this.key(artifact.url), JSON.stringify(artifact), Date.now() + ttl);
    this.db.prepare('DELETE FROM pages WHERE expires < ?').run(Date.now());
  }
  clear() {
    this.db.exec('DELETE FROM pages');
  }
  close() {
    this.db.close();
  }
}

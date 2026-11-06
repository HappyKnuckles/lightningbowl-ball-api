// Copies ball images from bowwwl.com to our image host (see 003_ball_images.sql).
//
// Each run copies images that have no copy yet, newest balls first, until it
// runs out of images or of its time budget; the nightly sync gives it what is
// left of the cron's time, `npm run mirror-images` runs until everything is
// copied. A failed image is retried on later runs, at most MAX_ATTEMPTS times.

import { createHash } from 'node:crypto';
import { query } from './db.js';
import type { ImageStore } from './r2.js';

/** Where bowwwl.com's relative image paths live. */
export const IMAGE_BASE = (process.env.BOWWWL_IMAGE_BASE || 'https://bowwwl.com').replace(/\/+$/, '');

const IMAGE_FIELDS = ['ball_image', 'core_image', 'thumbnail_image'] as const;
const MAX_ATTEMPTS = 3;
/** Larger files aren't ball pictures; skip rather than store them. */
const MAX_BYTES = 5 * 1024 * 1024;
const RETRY_AFTER = '1 day';
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

export interface MirrorStats {
  copied: number;
  failed: number;
  /** Images still without a copy after this run (not counting ones that ran out of attempts). */
  remaining: number;
  bytes: number;
}

export interface MirrorOptions {
  store: ImageStore;
  /** Stop starting new downloads after this long. */
  budgetMs?: number;
  /** At most this many images per run. */
  limit?: number;
  concurrency?: number;
  fetchFn?: (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'headers' | 'arrayBuffer'>>;
  log?: (message: string) => void;
}

/** The absolute URL of an upstream image path. */
export function sourceUrl(source: string): string {
  if (/^https?:\/\//i.test(source)) return source;
  return `${IMAGE_BASE}${source.startsWith('/') ? '' : '/'}${source}`;
}

/** Object key for an image: stable per source, so a copy never has to change. */
export function objectKey(source: string, contentType: string): string {
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 32);
  const extension = EXTENSIONS[contentType.split(';')[0]!.trim().toLowerCase()] ?? 'img';
  return `balls/${hash}.${extension}`;
}

/** Records every image of active balls that isn't known yet, so it gets copied. */
async function registerSources(): Promise<void> {
  await query(
    `INSERT INTO ball_images (source, first_seen_at)
     SELECT source, max(first_seen_at)
     FROM (
       SELECT nullif(raw->>field, '') AS source, first_seen_at
       FROM balls, unnest($1::text[]) AS field
       WHERE removed_at IS NULL
     ) images
     WHERE source IS NOT NULL
     GROUP BY source
     ON CONFLICT (source) DO NOTHING`,
    [IMAGE_FIELDS],
  );
}

/** Images to copy next: never tried first, then failed ones whose retry is due, newest balls first. */
async function nextSources(limit: number): Promise<string[]> {
  const { rows } = await query<{ source: string }>(
    `SELECT source FROM ball_images
     WHERE url IS NULL AND attempts < $1
       AND (attempts = 0 OR attempted_at < now() - $2::interval)
     ORDER BY attempts, first_seen_at DESC NULLS LAST, source
     LIMIT $3`,
    [MAX_ATTEMPTS, RETRY_AFTER, limit],
  );
  return rows.map((row) => row.source);
}

async function countRemaining(): Promise<number> {
  const { rows } = await query<{ n: number }>('SELECT count(*)::int AS n FROM ball_images WHERE url IS NULL AND attempts < $1', [MAX_ATTEMPTS]);
  return rows[0]?.n ?? 0;
}

async function copyOne(source: string, { store, fetchFn = fetch }: MirrorOptions): Promise<number> {
  const response = await fetchFn(sourceUrl(source), {
    headers: { 'User-Agent': 'lightningbowl-ball-api/1.0', Accept: 'image/*' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error(`not an image (${contentType || 'no content type'})`);
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength === 0) throw new Error('empty file');
  if (body.byteLength > MAX_BYTES) throw new Error(`too large (${body.byteLength} bytes)`);

  const key = objectKey(source, contentType);
  await store.put(key, body, contentType);
  await query(
    `UPDATE ball_images SET url = $2, object_key = $3, content_type = $4, bytes = $5, mirrored_at = now(),
       attempted_at = now(), attempts = attempts + 1, last_error = NULL
     WHERE source = $1`,
    [source, `${store.publicBase}/${key}`, key, contentType, body.byteLength],
  );
  return body.byteLength;
}

/** Copies images that have no copy yet; see the top of this file. */
export async function mirrorImages(options: MirrorOptions): Promise<MirrorStats> {
  const { budgetMs = Infinity, limit = Infinity, concurrency = 6, log = () => {} } = options;
  const deadline = Date.now() + budgetMs;
  const stats: MirrorStats = { copied: 0, failed: 0, remaining: 0, bytes: 0 };

  await registerSources();

  let started = 0;
  const tried = new Set<string>();
  while (Date.now() < deadline && started < limit) {
    const batch = (await nextSources(Math.min(100, limit - started))).filter((source) => !tried.has(source));
    if (batch.length === 0) break;

    let index = 0;
    const worker = async () => {
      while (index < batch.length && Date.now() < deadline && started < limit) {
        const source = batch[index++]!;
        tried.add(source);
        started++;
        try {
          // awaited first: `stats.bytes += await …` would read the total before other copies add to it
          const bytes = await copyOne(source, options);
          stats.bytes += bytes;
          stats.copied++;
        } catch (error) {
          stats.failed++;
          const message = (error as Error).message;
          log(`image ${source}: ${message}`);
          await query(`UPDATE ball_images SET attempts = attempts + 1, attempted_at = now(), last_error = $2 WHERE source = $1`, [source, message]);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  stats.remaining = await countRemaining();
  return stats;
}

// Finding a ball from a photo (see 004_image_embeddings.sql).
//
// The embedder service (embedder/, deployed separately) turns a picture into a
// unit-length vector. Each ball picture is embedded once: the nightly sync
// embeds new ones within its time budget, `npm run embed-images` embeds the
// whole catalog. A search embeds the user's photo the same way and returns the
// balls whose pictures have the closest vectors.
//
// The embedder is reached over HTTP (EMBEDDER_URL, EMBEDDER_KEY):
//   GET  /       → { model, dim }
//   POST /embed  (image bytes, Content-Type image/*) → { model, dim, embedding }
// 400 means the image couldn't be read; anything else non-2xx is the service failing.

import { z } from 'zod';
import { BALL_JSON } from './balls.js';
import { query } from './db.js';
import { type MirrorOptions, sourceUrl } from './images.js';
import type { Ball } from './schemas.js';
import type { FetchFn } from './upstream.js';

const MAX_ATTEMPTS = 3;
const RETRY_AFTER = '1 day';
/** Larger files aren't ball pictures (as in images.ts). */
const MAX_BYTES = 5 * 1024 * 1024;

export interface Embedding {
  model: string;
  /** Unit length. */
  vector: number[];
}

export interface Embedder {
  /** The model new embeddings come from. */
  model(): Promise<string>;
  embed(image: Uint8Array, contentType: string): Promise<Embedding>;
}

/** The embedder failed (down, timed out, answered nonsense); not the image's fault. */
export class EmbedderError extends Error {
  override name = 'EmbedderError';
}

/** The embedder couldn't read the image. */
export class ImageRejectedError extends Error {
  override name = 'ImageRejectedError';
}

const InfoResponse = z.object({ model: z.string().min(1) });
const EmbedResponse = z.object({ model: z.string().min(1), embedding: z.array(z.number()).min(2).max(4096) });

/** The vector scaled to length 1, so a dot product is the cosine similarity. */
export function unitVector(vector: number[]): number[] {
  const length = Math.hypot(...vector);
  if (!(length > 0) || !Number.isFinite(length)) throw new EmbedderError('embedding has no direction');
  return vector.map((v) => v / length);
}

export interface HttpEmbedderOptions {
  url: string;
  key?: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

/** The embedder service at `url`. */
export function httpEmbedder({ url, key, fetchFn = fetch, timeoutMs = 20000 }: HttpEmbedderOptions): Embedder {
  const base = url.replace(/\/+$/, '');
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};

  const request = async <T>(path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> => {
    let response;
    try {
      response = await fetchFn(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new EmbedderError(`embedder unreachable: ${(error as Error).message}`);
    }
    if (response.status === 400) throw new ImageRejectedError('the embedder could not read the image');
    if (!response.ok) throw new EmbedderError(`embedder answered HTTP ${response.status}`);
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new EmbedderError('embedder answered with an unexpected body');
    return parsed.data;
  };

  let model: Promise<string> | undefined;
  return {
    model() {
      // not kept when it fails, so a later call asks again
      model ??= request('/', { method: 'GET' }, InfoResponse).then(
        (info) => info.model,
        (error: unknown) => {
          model = undefined;
          throw error;
        },
      );
      return model;
    },
    async embed(image, contentType) {
      const body = await request('/embed', { method: 'POST', body: image, headers: { 'Content-Type': contentType } }, EmbedResponse);
      return { model: body.model, vector: unitVector(body.embedding) };
    },
  };
}

/** From EMBEDDER_URL (and EMBEDDER_KEY); null when image search isn't set up. */
export function embedderFromEnv(): Embedder | null {
  const url = process.env.EMBEDDER_URL?.trim();
  return url ? httpEmbedder({ url, key: process.env.EMBEDDER_KEY?.trim() || undefined }) : null;
}

// ------------------------------------------------------------- the catalog

export interface EmbedStats {
  embedded: number;
  failed: number;
  /** Pictures still without an embedding after this run (not counting ones that ran out of attempts). */
  remaining: number;
}

export interface EmbedOptions {
  embedder: Embedder;
  /** Stop starting new pictures after this long. */
  budgetMs?: number;
  /** At most this many pictures per run. */
  limit?: number;
  concurrency?: number;
  /** Loads the pictures. */
  fetchFn?: MirrorOptions['fetchFn'];
  log?: (message: string) => void;
}

/**
 * Pictures of active balls without an embedding of `model`, newest balls first, failed ones whose
 * retry is due after the rest. Only `ball_image`: the core picture and the thumbnail show
 * something else or the same picture smaller. Read from our copy when there is one.
 */
const PENDING_SQL = `
  FROM (
    SELECT raw->>'ball_image' AS source, max(first_seen_at) AS first_seen_at
    FROM balls
    WHERE removed_at IS NULL AND (raw->>'ball_image' ~* '^https?://' OR raw->>'ball_image' LIKE '/%')
    GROUP BY 1
  ) pictures
  LEFT JOIN image_embeddings e ON e.source = pictures.source AND e.model = $1
  WHERE e.source IS NULL OR (e.embedding IS NULL AND e.attempts < $2 AND e.attempted_at < now() - $3::interval)`;

async function nextPictures(model: string, limit: number): Promise<{ source: string; url: string | null }[]> {
  const { rows } = await query<{ source: string; url: string | null }>(
    `SELECT pictures.source, (SELECT url FROM ball_images WHERE ball_images.source = pictures.source) AS url
     ${PENDING_SQL}
     ORDER BY coalesce(e.attempts, 0), pictures.first_seen_at DESC, pictures.source
     LIMIT $4`,
    [model, MAX_ATTEMPTS, RETRY_AFTER, limit],
  );
  return rows;
}

async function countRemaining(model: string): Promise<number> {
  const { rows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (
       SELECT raw->>'ball_image' AS source FROM balls
       WHERE removed_at IS NULL AND (raw->>'ball_image' ~* '^https?://' OR raw->>'ball_image' LIKE '/%')
       GROUP BY 1
     ) pictures
     LEFT JOIN image_embeddings e ON e.source = pictures.source AND e.model = $1
     WHERE e.source IS NULL OR (e.embedding IS NULL AND e.attempts < $2)`,
    [model, MAX_ATTEMPTS],
  );
  return rows[0]?.n ?? 0;
}

async function loadPicture(url: string, fetchFn: NonNullable<MirrorOptions['fetchFn']>): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = await fetchFn(url, {
    headers: { 'User-Agent': 'lightningbowl-ball-api/1.0', Accept: 'image/*' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new ImageRejectedError(`HTTP ${response.status}`);
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!contentType.startsWith('image/')) throw new ImageRejectedError(`not an image (${contentType || 'no content type'})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new ImageRejectedError('empty file');
  if (bytes.byteLength > MAX_BYTES) throw new ImageRejectedError(`too large (${bytes.byteLength} bytes)`);
  return { bytes, contentType };
}

/**
 * Embeds ball pictures that have no embedding of the embedder's model yet; see the top of this file.
 * A picture that can't be loaded or read is retried on later runs; when the embedder itself fails,
 * the run stops (with an EmbedderError) instead of counting that against every picture.
 */
export async function embedImages({
  embedder,
  budgetMs = Infinity,
  limit = Infinity,
  concurrency = 4,
  fetchFn = fetch,
  log = () => {},
}: EmbedOptions): Promise<EmbedStats> {
  const deadline = Date.now() + budgetMs;
  const stats: EmbedStats = { embedded: 0, failed: 0, remaining: 0 };
  const model = await embedder.model();

  let started = 0;
  let broken: Error | undefined;
  while (!broken && Date.now() < deadline && started < limit) {
    const batch = await nextPictures(model, Math.min(100, limit - started));
    if (batch.length === 0) break;

    let index = 0;
    const worker = async () => {
      while (!broken && index < batch.length && Date.now() < deadline && started < limit) {
        const { source, url } = batch[index++]!;
        started++;
        try {
          const picture = await loadPicture(url ?? sourceUrl(source), fetchFn);
          const embedding = await embedder.embed(picture.bytes, picture.contentType);
          // stored under another model, the picture would stay pending and come round again and again
          if (embedding.model !== model) throw new EmbedderError(`the embedder switched from ${model} to ${embedding.model} during the run`);
          await query(
            `INSERT INTO image_embeddings (source, model, embedding, attempts, attempted_at, embedded_at)
             VALUES ($1, $2, $3::real[], 1, now(), now())
             ON CONFLICT (source, model) DO UPDATE SET embedding = excluded.embedding, attempts = image_embeddings.attempts + 1,
               last_error = NULL, attempted_at = now(), embedded_at = now()`,
            [source, embedding.model, embedding.vector],
          );
          stats.embedded++;
        } catch (error) {
          if (!(error instanceof ImageRejectedError)) {
            broken ??= error as Error;
            return;
          }
          stats.failed++;
          log(`embedding ${source}: ${error.message}`);
          await query(
            `INSERT INTO image_embeddings (source, model, attempts, last_error, attempted_at) VALUES ($1, $2, 1, $3, now())
             ON CONFLICT (source, model) DO UPDATE SET attempts = image_embeddings.attempts + 1, last_error = excluded.last_error,
               attempted_at = now()`,
            [source, model, error.message],
          );
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }
  if (broken) throw broken;

  stats.remaining = await countRemaining(model);
  return stats;
}

// ------------------------------------------------------------------ search

/** The file types a photo may come in, by their first bytes. */
const SIGNATURES: [contentType: string, matches: (b: Uint8Array) => boolean][] = [
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ['image/webp', (b) => String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP'],
];

/** A photo sent as base64 or a data URL; null when it isn't a JPEG, PNG or WebP of at most `maxBytes`. */
export function decodeImage(text: string, maxBytes: number): { bytes: Uint8Array; contentType: string } | null {
  const base64 = text.replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null;
  const contentType = SIGNATURES.find(([, matches]) => matches(bytes))?.[0];
  return contentType ? { bytes, contentType } : null;
}

export interface ImageMatch {
  score: number;
  ball: Ball;
}

/**
 * Balls whose picture is closest to `embedding`, best first, each ball once (in `weight`, or its
 * heaviest weight). `score` is the cosine similarity of the two pictures, up to 1.
 */
export async function findBallsByImage(embedding: Embedding, { weight, limit }: { weight?: number; limit: number }): Promise<ImageMatch[]> {
  const { rows } = await query<ImageMatch>(
    `WITH scored AS (
       SELECT source, (SELECT sum(a * b) FROM unnest(embedding, $1::real[]) AS v(a, b))::float8 AS score
       FROM image_embeddings
       WHERE model = $2 AND embedding IS NOT NULL
     ),
     matches AS (
       SELECT DISTINCT ON (ball_id) scored.score, ${BALL_JSON} AS ball
       FROM scored JOIN balls ON balls.raw->>'ball_image' = scored.source
       WHERE removed_at IS NULL AND ($3::numeric IS NULL OR weight = $3)
       ORDER BY ball_id, scored.score DESC, weight DESC NULLS LAST, core_weight
     )
     SELECT score, ball FROM matches ORDER BY score DESC, ball->>'ball_id' LIMIT $4`,
    [embedding.vector, embedding.model, weight ?? null, limit],
  );
  return rows.map((row) => ({ score: Math.round(row.score * 10000) / 10000, ball: row.ball }));
}

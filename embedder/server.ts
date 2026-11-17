// The HTTP side of the embedder, kept apart from the model so it can be tested without one.
//   GET  /       → { model, dim }
//   POST /embed  (image bytes as the body) → { model, dim, embedding }   (unit length)
// 400: the body isn't a picture; 401: wrong or missing key; 413: too large.
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';

export interface ImageModel {
  /** Changes whenever the vectors would: the Ball API embeds every picture again under a new name. */
  name: string;
  dim: number;
  /** A unit-length vector; UnreadableImageError when the bytes aren't a picture. */
  embed(image: Uint8Array): Promise<number[]>;
}

export class UnreadableImageError extends Error {
  override name = 'UnreadableImageError';
}

class TooLargeError extends Error {}

export interface ServerOptions {
  /** Required as `Authorization: Bearer <key>` when set. */
  key?: string;
  maxBytes?: number;
  /** Pictures embedded at the same time; 1 (default) keeps memory flat and suits a one-core server. */
  concurrency?: number;
  log?: (message: string) => void;
}

function authorized(req: http.IncomingMessage, key: string | undefined): boolean {
  if (!key) return true;
  const expected = Buffer.from(`Bearer ${key}`);
  const actual = Buffer.from(req.headers.authorization ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > maxBytes) throw new TooLargeError();
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export function createEmbedderServer(
  model: ImageModel,
  { key, maxBytes = 8 * 1024 * 1024, concurrency = 1, log = console.error }: ServerOptions = {},
): http.Server {
  // at most `concurrency` pictures at a time; the rest wait their turn
  let running = 0;
  const waiting: (() => void)[] = [];
  const embedInTurn = async (image: Uint8Array) => {
    if (running >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await model.embed(image);
    } finally {
      running--;
      waiting.shift()?.();
    }
  };

  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    try {
      if (!authorized(req, key)) {
        req.resume();
        return send(401, { error: 'Unauthorized' });
      }
      if (path === '/' && req.method === 'GET') {
        return send(200, { model: model.name, dim: model.dim });
      }
      if (path === '/embed' && req.method === 'POST') {
        const image = await readBody(req, maxBytes);
        if (image.byteLength === 0) return send(400, { error: 'Send the picture as the request body' });
        const embedding = await embedInTurn(image);
        return send(200, { model: model.name, dim: embedding.length, embedding });
      }
      req.resume();
      return send(path === '/' || path === '/embed' ? 405 : 404, { error: path === '/' || path === '/embed' ? 'Method not allowed' : 'Not found' });
    } catch (error) {
      if (error instanceof TooLargeError) {
        res.setHeader('Connection', 'close');
        return send(413, { error: `Larger than ${maxBytes} bytes` });
      }
      if (error instanceof UnreadableImageError) return send(400, { error: error.message });
      log(`embed failed: ${(error as Error).stack ?? error}`);
      return send(500, { error: 'Embedding failed' });
    }
  });
}

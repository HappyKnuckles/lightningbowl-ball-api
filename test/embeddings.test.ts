import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { imageSearchHandler } from '../api/balls/image-search.js';
import imageSearch from '../api/balls/image-search.js';
import { query } from '../lib/db.js';
import { decodeImage, type Embedder, EmbedderError, embedImages, httpEmbedder, ImageRejectedError, unitVector } from '../lib/embeddings.js';
import { runSync } from '../lib/sync.js';
import { fakeUpstream, upstreamBall } from './helpers/fixtures.js';
import { resetDatabase, startDatabase } from './helpers/db.js';
import { call } from './helpers/http.js';

let stop: () => Promise<void>;
before(async () => {
  stop = await startDatabase();
});
after(() => stop());
beforeEach(() => resetDatabase());

// Ball 1 in two weights shares its picture; ball 3 looks a lot like ball 1, ball 2 doesn't; ball 4 has no picture.
const BALLS_15 = [
  upstreamBall({ ball_id: '1', ball_image: '/img/1.png', core_image: '/img/core-1.png', thumbnail_image: '/img/1-thumb.png' }),
  upstreamBall({ ball_id: '2', ball_name: 'Phaze V', ball_image: '/img/2.png' }),
  upstreamBall({ ball_id: '3', ball_name: 'Phaze 4', ball_image: '/img/3.png' }),
  upstreamBall({ ball_id: '4', ball_name: 'Jackal Ghost', ball_image: '' }),
];
const BALLS_14 = [upstreamBall({ ball_id: '1', core_weight: '14', ball_image: '/img/1.png' })];

/** What the fake embedder makes of each picture (by the URL it was loaded from) and of each photo. */
const VECTORS: Record<string, number[]> = {
  'https://bowwwl.com/img/1.png': [1, 0, 0],
  'https://bowwwl.com/img/2.png': [0, 1, 0],
  'https://bowwwl.com/img/3.png': [0.8, 0.6, 0],
  'https://images.test/balls/2.png': [0, 1, 0],
  'like-1': [0.9, 0.1, 0.1],
  'like-2': [0.1, 1, 0],
};

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A "PNG" carrying `text`, which the fake embedder reads back. */
const png = (text: string) => new Uint8Array([...PNG, ...new TextEncoder().encode(text)]);
const photo = (text: string) => Buffer.from(png(text)).toString('base64');

function fakeEmbedder(model = 'test-clip', { down = false } = {}) {
  const embedded: string[] = [];
  const embedder: Embedder = {
    model: async () => model,
    async embed(image) {
      const text = new TextDecoder().decode(image.subarray(PNG.length));
      embedded.push(text);
      if (down) throw new EmbedderError('embedder unreachable: connection refused');
      const vector = VECTORS[text];
      if (!vector) throw new ImageRejectedError('the embedder could not read the image');
      return { model, vector: unitVector(vector) };
    },
  };
  return { embedder, embedded };
}

/** Serves every picture as a "PNG" of its URL, except the ones listed as failing. */
function fakePictures(failing: Record<string, number> = {}) {
  const requested: string[] = [];
  const fetchFn = async (url: string) => {
    requested.push(url);
    return {
      ok: !failing[url],
      status: failing[url] ?? 200,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => png(url).buffer as ArrayBuffer,
    };
  };
  return { fetchFn, requested };
}

async function syncBalls() {
  await runSync({
    weights: [14, 15],
    fetchFn: fakeUpstream({ 15: BALLS_15, 14: BALLS_14 }).fetchFn,
    log: () => {},
    imageStore: null,
    embedder: null,
  });
}

async function embeddedSources(model = 'test-clip') {
  const { rows } = await query<{ source: string }>('SELECT source FROM image_embeddings WHERE model = $1 AND embedding IS NOT NULL ORDER BY source', [
    model,
  ]);
  return rows.map((row) => row.source);
}

const search = (image: string, params: Record<string, string> = {}, embedder: Embedder | null = fakeEmbedder().embedder) =>
  call(
    imageSearchHandler(() => embedder),
    params,
    { method: 'POST', body: { image } },
  );

test('embeds each ball picture once, from our copy when there is one; not the core picture or thumbnail', async () => {
  await syncBalls();
  await query(`INSERT INTO ball_images (source, url) VALUES ('/img/2.png', 'https://images.test/balls/2.png')`);
  const { embedder, embedded } = fakeEmbedder();
  const pictures = fakePictures();

  const stats = await embedImages({ embedder, fetchFn: pictures.fetchFn });

  assert.deepEqual(stats, { embedded: 3, failed: 0, remaining: 0 });
  assert.deepEqual(pictures.requested.sort(), ['https://bowwwl.com/img/1.png', 'https://bowwwl.com/img/3.png', 'https://images.test/balls/2.png']);
  assert.deepEqual(await embeddedSources(), ['/img/1.png', '/img/2.png', '/img/3.png']);
  const { rows } = await query<{ length: number }>(
    `SELECT sqrt(sum(v * v))::float8 AS length FROM image_embeddings, unnest(embedding) v WHERE source = '/img/3.png'`,
  );
  assert.ok(Math.abs(rows[0]!.length - 1) < 1e-6, 'stored at unit length');

  assert.deepEqual(await embedImages({ embedder, fetchFn: pictures.fetchFn }), { embedded: 0, failed: 0, remaining: 0 });
  assert.equal(embedded.length, 3, 'nothing embedded twice');
});

test('a picture that fails is retried on later runs, at most three times', async () => {
  await syncBalls();
  const { embedder } = fakeEmbedder();
  const pictures = fakePictures({ 'https://bowwwl.com/img/2.png': 404 });

  const first = await embedImages({ embedder, fetchFn: pictures.fetchFn });
  assert.deepEqual(first, { embedded: 2, failed: 1, remaining: 1 });
  const { rows } = await query(`SELECT attempts, last_error FROM image_embeddings WHERE source = '/img/2.png'`);
  assert.deepEqual(rows, [{ attempts: 1, last_error: 'HTTP 404' }]);

  // not again in the next run on the same day
  assert.deepEqual(await embedImages({ embedder, fetchFn: pictures.fetchFn }), { embedded: 0, failed: 0, remaining: 1 });

  for (let run = 0; run < 3; run++) {
    await query(`UPDATE image_embeddings SET attempted_at = now() - interval '2 days'`);
    await embedImages({ embedder, fetchFn: pictures.fetchFn });
  }
  const { rows: final } = await query(`SELECT attempts FROM image_embeddings WHERE source = '/img/2.png'`);
  assert.deepEqual(final, [{ attempts: 3 }]);
});

test('when the embedder is down the run stops, without counting it against the pictures', async () => {
  await syncBalls();
  const { embedder, embedded } = fakeEmbedder('test-clip', { down: true });

  await assert.rejects(embedImages({ embedder, fetchFn: fakePictures().fetchFn, concurrency: 1 }), /embedder unreachable/);

  assert.equal(embedded.length, 1);
  assert.equal((await query('SELECT * FROM image_embeddings')).rowCount, 0);
});

test('a new model embeds every picture again, and a search only compares with its own model', async () => {
  await syncBalls();
  await embedImages({ embedder: fakeEmbedder('test-clip').embedder, fetchFn: fakePictures().fetchFn });

  const next = fakeEmbedder('test-clip-2');
  assert.deepEqual(await embedImages({ embedder: next.embedder, fetchFn: fakePictures().fetchFn }), { embedded: 3, failed: 0, remaining: 0 });
  assert.equal((await query('SELECT * FROM image_embeddings')).rowCount, 6);

  await query(`DELETE FROM image_embeddings WHERE model = 'test-clip-2'`);
  const res = await search(photo('like-1'), {}, next.embedder);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, []);
});

test('finds the most alike balls first, each ball once', async () => {
  await syncBalls();
  await embedImages({ embedder: fakeEmbedder().embedder, fetchFn: fakePictures().fetchFn });

  const res = await search(photo('like-1'));

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(
    res.body.map((match: { ball: { key: string } }) => match.ball.key),
    ['1-15', '3-15', '2-15'],
    'ball 1 in its heaviest weight, then the one that looks like it',
  );
  assert.ok(res.body[0].score > 0.98 && res.body[0].score <= 1);
  assert.ok(res.body[1].score > res.body[2].score);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.equal(res.body[0].ball.ball_name, 'Phaze II');

  const light = await search(photo('like-1'), { weight: '14', limit: '1' });
  assert.deepEqual(
    light.body.map((match: { ball: { key: string } }) => match.ball.key),
    ['1-14'],
  );

  const other = await search(`data:image/png;base64,${photo('like-2')}`, { limit: '1' });
  assert.equal(other.body[0].ball.ball_id, '2');
});

test('balls removed upstream are not found any more', async () => {
  await syncBalls();
  await embedImages({ embedder: fakeEmbedder().embedder, fetchFn: fakePictures().fetchFn });
  await query(`UPDATE balls SET removed_at = now() WHERE ball_id = '1'`);

  const res = await search(photo('like-1'));
  assert.deepEqual(
    res.body.map((match: { ball: { ball_id: string } }) => match.ball.ball_id),
    ['3', '2'],
  );
});

test('rejects what is not a photo, and says when the search is not set up or failing', async () => {
  assert.equal(
    (
      await call(
        imageSearchHandler(() => fakeEmbedder().embedder),
        {},
        { method: 'POST' },
      )
    ).body.error,
    'Body must be a JSON object',
  );
  assert.match(
    (
      await call(
        imageSearchHandler(() => fakeEmbedder().embedder),
        {},
        { method: 'POST', body: '{nope' },
      )
    ).body.error,
    /must be JSON/,
  );
  assert.match((await search('')).body.error, /^Field "image"/);
  assert.match((await search(Buffer.from('GIF89a').toString('base64'))).body.error, /JPEG, PNG or WebP/);
  assert.match((await search('%%%')).body.error, /JPEG, PNG or WebP/);
  assert.equal((await search(photo('like-1'), { limit: '0' })).statusCode, 400);

  const unreadable = await search(photo('scribble'));
  assert.equal(unreadable.statusCode, 400);
  assert.match(unreadable.body.error, /could not be read/);

  const unset = await search(photo('like-1'), {}, null);
  assert.equal(unset.statusCode, 503);

  const down = await search(photo('like-1'), {}, fakeEmbedder('test-clip', { down: true }).embedder);
  assert.equal(down.statusCode, 502);
  assert.match(down.body.error, /unavailable/);
});

test('the endpoint takes POST and allows it for the app', async () => {
  const get = await call(imageSearch);
  assert.equal(get.statusCode, 405);

  const preflight = await call(imageSearch, {}, { method: 'OPTIONS', headers: { origin: 'null' } });
  assert.equal(preflight.statusCode, 200);
  assert.equal(preflight.headers['access-control-allow-methods'], 'POST,OPTIONS');

  // without EMBEDDER_URL the real endpoint answers that it isn't set up
  const unset = await call(imageSearch, {}, { method: 'POST', body: { image: photo('like-1') } });
  assert.equal(unset.statusCode, 503);
});

test('the nightly sync embeds new pictures after copying them, and warns when it cannot', async () => {
  const { embedder } = fakeEmbedder();
  const run = await runSync({
    weights: [14, 15],
    fetchFn: fakeUpstream({ 15: BALLS_15, 14: BALLS_14 }).fetchFn,
    log: () => {},
    imageStore: null,
    imageFetchFn: fakePictures().fetchFn,
    embedder,
  });
  assert.ok(!('skipped' in run));
  assert.deepEqual(run.stats.embeddings, { embedded: 3, failed: 0, remaining: 0 });
  assert.equal(run.status, 'success');

  const without = await runSync({ weights: [15], fetchFn: fakeUpstream({ 15: BALLS_15 }).fetchFn, log: () => {}, imageStore: null, embedder: null });
  assert.ok(!('skipped' in without));
  assert.match((without.stats.warnings as string[]).join(), /EMBEDDER_URL is not set/);

  const down = await runSync({
    weights: [15],
    fetchFn: fakeUpstream({ 15: BALLS_15 }).fetchFn,
    log: () => {},
    imageStore: null,
    embedder: { model: () => Promise.reject(new EmbedderError('embedder unreachable: timeout')), embed: () => Promise.reject(new Error()) },
  });
  assert.ok(!('skipped' in down));
  assert.equal(down.status, 'partial');
  assert.match(down.errors.join(), /embeddings: embedder unreachable/);
});

test('talks to the embedder service over HTTP', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: { model: 'clip-b32', dim: 2 } };
  const fetchFn = async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return { ok: answer.status < 300, status: answer.status, json: async () => answer.body };
  };
  const embedder = httpEmbedder({ url: 'https://embed.test/', key: 'k3y', fetchFn });

  assert.equal(await embedder.model(), 'clip-b32');
  assert.equal(await embedder.model(), 'clip-b32');
  assert.equal(requests.length, 1, 'the model is asked for once');
  assert.equal(requests[0]!.url, 'https://embed.test/');

  answer = { status: 200, body: { model: 'clip-b32', dim: 2, embedding: [3, 4] } };
  assert.deepEqual(await embedder.embed(png('x'), 'image/png'), { model: 'clip-b32', vector: [0.6, 0.8] });
  const sent = requests[1]!;
  assert.equal(sent.url, 'https://embed.test/embed');
  assert.equal(sent.init.method, 'POST');
  assert.deepEqual(sent.init.headers, { Authorization: 'Bearer k3y', 'Content-Type': 'image/png' });

  answer = { status: 400, body: { error: 'cannot identify image' } };
  await assert.rejects(embedder.embed(png('x'), 'image/png'), ImageRejectedError);
  answer = { status: 503, body: {} };
  await assert.rejects(embedder.embed(png('x'), 'image/png'), EmbedderError);
  answer = { status: 200, body: { model: 'clip-b32', embedding: 'nope' } };
  await assert.rejects(embedder.embed(png('x'), 'image/png'), /unexpected body/);
  answer = { status: 200, body: { model: 'clip-b32', embedding: [0, 0] } };
  await assert.rejects(embedder.embed(png('x'), 'image/png'), /no direction/);

  const failing = httpEmbedder({
    url: 'https://down.test',
    fetchFn: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await assert.rejects(failing.model(), /embedder unreachable: ECONNREFUSED/);
  await assert.rejects(failing.model(), /ECONNREFUSED/, 'a failed answer is not kept');
});

test('decodes photos sent as base64 or data URLs', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString('base64');
  assert.equal(decodeImage(jpeg, 100)?.contentType, 'image/jpeg');
  assert.equal(decodeImage(`data:image/jpeg;base64,${jpeg}`, 100)?.bytes.byteLength, 6);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]).toString('base64');
  assert.equal(decodeImage(webp, 100)?.contentType, 'image/webp');
  assert.equal(decodeImage(jpeg, 5), null, 'too large');
  assert.equal(decodeImage('not base64!', 100), null);
  assert.equal(decodeImage(Buffer.from('<svg/>').toString('base64'), 100), null);
});

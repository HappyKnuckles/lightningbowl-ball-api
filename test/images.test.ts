import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import ballsHandler from '../api/balls/index.js';
import healthHandler from '../api/health.js';
import { query } from '../lib/db.js';
import { mirrorImages, objectKey, sourceUrl } from '../lib/images.js';
import { type ImageStore, r2ConfigFromEnv, signS3Request } from '../lib/r2.js';
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

// Two weights of ball 1 share their images; ball 2 is newer and has its own.
const BALLS = [
  upstreamBall({ ball_id: '1', ball_image: '/img/1.png', thumbnail_image: '/img/1-thumb.png' }),
  upstreamBall({ ball_id: '2', ball_name: 'Phaze V', ball_image: '/img/2.png', core_image: 'https://cdn.example/core-2.jpg' }),
];
const BALLS_14 = [upstreamBall({ ball_id: '1', core_weight: '14', ball_image: '/img/1.png', thumbnail_image: '/img/1-thumb.png' })];

function fakeStore() {
  const puts: { key: string; bytes: number; contentType: string }[] = [];
  const store: ImageStore = {
    publicBase: 'https://images.test',
    async put(key, body, contentType) {
      puts.push({ key, bytes: body.byteLength, contentType });
    },
  };
  return { store, puts };
}

/** Serves an image for every URL except the ones listed as failing (by status or content type). */
function fakeImages(failing: Record<string, { status?: number; type?: string }> = {}) {
  const requested: string[] = [];
  const fetchFn = async (url: string) => {
    requested.push(url);
    const fail = failing[url];
    const type = fail?.type ?? (url.endsWith('.jpg') ? 'image/jpeg' : 'image/png');
    return {
      ok: !fail?.status,
      status: fail?.status ?? 200,
      headers: new Headers({ 'content-type': type }),
      arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    };
  };
  return { fetchFn, requested };
}

async function syncBalls() {
  await runSync({ weights: [14, 15], fetchFn: fakeUpstream({ 15: BALLS, 14: BALLS_14 }).fetchFn, log: () => {}, imageStore: null });
}

test('turns bowwwl.com paths into absolute URLs and gives each source a stable object key', () => {
  assert.equal(sourceUrl('/sites/default/files/a.png'), 'https://bowwwl.com/sites/default/files/a.png');
  assert.equal(sourceUrl('https://cdn.example/b.jpg'), 'https://cdn.example/b.jpg');
  assert.match(objectKey('/img/1.png', 'image/png'), /^balls\/[0-9a-f]{32}\.png$/);
  assert.equal(objectKey('/img/1.png', 'image/png'), objectKey('/img/1.png', 'image/png'));
  assert.notEqual(objectKey('/img/1.png', 'image/png'), objectKey('/img/2.png', 'image/png'));
  assert.match(objectKey('/x', 'image/jpeg; charset=binary'), /\.jpg$/);
});

test('copies each image once, newest balls first, and the API returns the copies', async () => {
  await syncBalls();
  await query(`UPDATE balls SET first_seen_at = now() + interval '1 day' WHERE ball_id = '2'`);
  const { store, puts } = fakeStore();
  const images = fakeImages();

  const stats = await mirrorImages({ store, fetchFn: images.fetchFn, concurrency: 1 });

  assert.deepEqual(stats, { copied: 4, failed: 0, remaining: 0, bytes: 16 });
  assert.equal(puts.length, 4);
  assert.deepEqual(images.requested.slice(0, 2).sort(), ['https://bowwwl.com/img/2.png', 'https://cdn.example/core-2.jpg']);
  assert.equal(puts.find((put) => put.key.endsWith('.jpg'))?.contentType, 'image/jpeg');

  const res = await call(ballsHandler, { weight: '15' });
  const ball1 = res.body.content.find((ball: { ball_id: string }) => ball.ball_id === '1');
  assert.match(ball1.ball_image, /^https:\/\/images\.test\/balls\/[0-9a-f]{32}\.png$/);
  assert.match(ball1.thumbnail_image, /^https:\/\/images\.test\/balls\//);
  assert.equal(ball1.core_image, null);

  // nothing left: a second run copies nothing
  const again = await mirrorImages({ store, fetchFn: images.fetchFn });
  assert.equal(again.copied, 0);
  assert.equal(puts.length, 4);
});

test("keeps returning bowwwl.com's URL until an image is copied", async () => {
  await syncBalls();
  const res = await call(ballsHandler, { weight: '15', id: '1' });
  assert.equal(res.body.content[0].ball_image, 'https://bowwwl.com/img/1.png');
});

test('only copies what the API can turn into a URL', async () => {
  await runSync({
    weights: [15],
    fetchFn: fakeUpstream({ 15: [upstreamBall({ ball_id: '9', ball_image: 'n/a', thumbnail_image: '/img/9.png' })] }).fetchFn,
    log: () => {},
    imageStore: null,
  });

  const stats = await mirrorImages({ store: fakeStore().store, fetchFn: fakeImages().fetchFn });

  assert.equal(stats.copied, 1);
  const { rows } = await query<{ source: string }>('SELECT source FROM ball_images');
  assert.deepEqual(
    rows.map((row) => row.source),
    ['/img/9.png'],
  );
});

test('retries failed images on a later day, three times at most', async () => {
  await syncBalls();
  const { store } = fakeStore();
  const images = fakeImages({ 'https://bowwwl.com/img/1.png': { status: 404 }, 'https://bowwwl.com/img/2.png': { type: 'text/html' } });

  const first = await mirrorImages({ store, fetchFn: images.fetchFn });
  assert.deepEqual([first.copied, first.failed, first.remaining], [2, 2, 2]);
  const { rows } = await query(`SELECT source, attempts, last_error FROM ball_images WHERE url IS NULL ORDER BY source`);
  assert.deepEqual(rows, [
    { source: '/img/1.png', attempts: 1, last_error: 'HTTP 404' },
    { source: '/img/2.png', attempts: 1, last_error: 'not an image (text/html)' },
  ]);

  // not again on the same day
  assert.equal((await mirrorImages({ store, fetchFn: images.fetchFn })).failed, 0);

  // a day later, twice more, then it gives up
  for (let day = 0; day < 3; day++) {
    await query(`UPDATE ball_images SET attempted_at = now() - interval '2 days' WHERE url IS NULL`);
    await mirrorImages({ store, fetchFn: images.fetchFn });
  }
  const { rows: given } = await query<{ attempts: number }>(`SELECT attempts FROM ball_images WHERE url IS NULL`);
  assert.deepEqual(
    given.map((row) => row.attempts),
    [3, 3],
  );
  assert.equal((await mirrorImages({ store, fetchFn: images.fetchFn })).remaining, 0);
});

test('stops at its limit and leaves the rest for the next run', async () => {
  await syncBalls();
  const { store } = fakeStore();

  const stats = await mirrorImages({ store, fetchFn: fakeImages().fetchFn, limit: 1 });

  assert.deepEqual([stats.copied, stats.remaining], [1, 3]);
});

test('the sync copies images after the balls and reports them; health counts them', async () => {
  const { store, puts } = fakeStore();
  const run = (await runSync({
    weights: [15],
    fetchFn: fakeUpstream({ 15: BALLS }).fetchFn,
    log: () => {},
    imageStore: store,
    imageFetchFn: fakeImages().fetchFn,
  })) as { status: string; stats: Record<string, unknown> };

  assert.equal(run.status, 'success');
  assert.deepEqual(run.stats.images, { copied: 4, failed: 0, remaining: 0, bytes: 16 });
  assert.equal(puts.length, 4);

  process.env.ADMIN_SECRET = 'admin-secret';
  const health = await call(healthHandler, {}, { headers: { authorization: 'Bearer admin-secret' } });
  assert.equal(health.body.counts.images_copied, 4);
  assert.equal(health.body.counts.images_pending, 0);
});

test('without R2 settings the sync says so and copies nothing', async () => {
  const run = await runSync({ weights: [15], fetchFn: fakeUpstream({ 15: BALLS }).fetchFn, log: () => {}, imageStore: null });
  assert.ok('stats' in run);
  assert.equal(run.stats.images, undefined);
  assert.match((run.stats.warnings as string[]).join(), /R2 is not configured/);
  assert.equal(r2ConfigFromEnv({}), null);
  assert.deepEqual(r2ConfigFromEnv({ R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_PUBLIC_DOMAIN: 'https://img.test/' }), {
    accountId: 'a',
    accessKeyId: 'k',
    secretAccessKey: 's',
    bucket: 'pattern-charts',
    publicBase: 'https://img.test',
  });
});

test('signs requests like AWS documents it (Signature V4, "PUT Object" example)', () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
  const headers = signS3Request(
    {
      method: 'PUT',
      url: new URL('https://examplebucket.s3.amazonaws.com/test%24file.text'),
      headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      body: new TextEncoder().encode('Welcome to Amazon S3.'),
    },
    { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    new Date('2013-05-24T00:00:00Z'),
    'us-east-1',
  );

  assert.equal(
    headers.Authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
      'SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, ' +
      'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
  );
  assert.equal(headers['x-amz-content-sha256'], '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
});

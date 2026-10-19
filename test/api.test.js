import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import ballHandler from '../api/balls/[id]/index.js';
import similarHandler from '../api/balls/[id]/similar.js';
import ballsHandler from '../api/balls/index.js';
import brandsHandler from '../api/brands.js';
import coresHandler from '../api/cores.js';
import cronHandler from '../api/cron/sync.js';
import healthHandler from '../api/health.js';
import { runSync } from '../lib/sync.js';
import { BALLS_15, fakeUpstream, upstreamBall } from './helpers/fixtures.js';
import { startDatabase } from './helpers/db.js';
import { call } from './helpers/http.js';

let stop;
before(async () => {
  stop = await startDatabase();
  const extra = [
    upstreamBall({ ball_id: '6', ball_name: 'Close Match', core_rg: '2.50', core_diff: '0.055', release_date: '2024-01-01' }),
    upstreamBall({ ball_id: '7', ball_name: 'Far Off', core_rg: '2.60', release_date: '2024-02-01' }),
    upstreamBall({ ball_id: '8', ball_name: '100% Pearl_Test', coverstock_type: 'Pearl Reactive', release_date: '2010-01-01' }),
  ];
  await runSync({ weights: [14, 15], fetchFn: fakeUpstream({ 15: [...BALLS_15, ...extra] }).fetchFn, log: () => {} });
});
after(() => stop());

const ids = (res) => res.body.content.map((b) => `${b.ball_id}-${b.core_weight}`);

test('lists balls newest first in a Spring-style page with cache headers', async () => {
  const res = await call(ballsHandler, { weight: '15', size: '3' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(ids(res), ['7-15', '6-15', '2-15']);
  assert.deepEqual(res.body.page, { number: 0, size: 3, totalElements: 7, totalPages: 3 });
  assert.match(res.headers['cache-control'], /s-maxage=/);
  assert.equal(res.headers.vary, 'Origin');
});

test('returns the upstream object shape plus first_seen_at', async () => {
  const res = await call(ballsHandler, { id: '3' });
  const ball = res.body.content[0];
  assert.equal(ball.core_rg, '2.50');
  assert.equal(ball.ball_name, 'Black Widow 3.0');
  assert.ok(ball.first_seen_at);
});

test('filters case-insensitively and combines filters', async () => {
  assert.deepEqual(ids(await call(ballsHandler, { brand: ['hammer', 'MOTIV'], sort: 'ball_name' })), ['3-15', '4-15']);
  assert.deepEqual(ids(await call(ballsHandler, { market: 'overseas' })), ['3-15']);
  assert.deepEqual(ids(await call(ballsHandler, { coreType: 'asymmetric' })), ['3-15']);
  assert.deepEqual(ids(await call(ballsHandler, { available: 'false' })), ['3-15']);
  assert.deepEqual(ids(await call(ballsHandler, { coverstock: 'aggression' })), ['3-15']);
  assert.deepEqual(ids(await call(ballsHandler, { weight: '14' })), ['1-14']);
  assert.deepEqual(ids(await call(ballsHandler, { id: '1', sort: 'weight,desc' })), ['1-15', '1-14']);
  assert.deepEqual(ids(await call(ballsHandler, { core: 'Velocity', excludeId: ['1', '6', '7', '8'], weight: '15' })), ['2-15', '4-15']);
});

test('numeric and date ranges', async () => {
  assert.deepEqual(ids(await call(ballsHandler, { minRg: '2.49', maxRg: '2.5', sort: 'core_rg' })), ['2-15', '3-15', '6-15']);
  assert.deepEqual(ids(await call(ballsHandler, { releasedAfter: '2021-01-01', releasedBefore: '2022-12-31' })), ['3-15', '4-15']);
  assert.equal((await call(ballsHandler, { minRg: '3', maxRg: '2' })).statusCode, 400);
  assert.equal((await call(ballsHandler, { releasedAfter: 'yesterday' })).statusCode, 400);
});

test('sorting puts NULLs last and supports tie-breakers', async () => {
  const res = await call(ballsHandler, { weight: '15', sort: ['core_rg,desc', 'ball_name'] });
  assert.equal(ids(res).at(-1), '4-15'); // core_rg 'n/a' → NULL → last
  assert.equal(ids(res)[0], '7-15');
});

test('rejects unknown sort fields and bad paging', async () => {
  assert.equal((await call(ballsHandler, { sort: 'raw' })).statusCode, 400);
  assert.equal((await call(ballsHandler, { size: '500' })).statusCode, 400);
  assert.equal((await call(ballsHandler, { market: 'Mars' })).statusCode, 400);
});

test('search is fuzzy, ranks by relevance and accepts several terms', async () => {
  assert.deepEqual(ids(await call(ballsHandler, { search: 'widow' })), ['3-15']);
  assert.ok(ids(await call(ballsHandler, { search: 'jackel' })).includes('4-15'), 'tolerates a typo');
  assert.deepEqual(ids(await call(ballsHandler, { q: 'jackal, widow' })).sort(), ['3-15', '4-15']);
  assert.deepEqual(ids(await call(ballsHandler, { search: 'gas mask' })), ['3-15'], 'matches core names');
  const hammer = await call(ballsHandler, { search: 'hammer' });
  assert.equal(ids(hammer)[0], '3-15', 'matches brands');
});

test('search treats LIKE wildcards literally', async () => {
  assert.deepEqual(ids(await call(ballsHandler, { search: '100%' })), ['8-15']);
  assert.deepEqual(ids(await call(ballsHandler, { search: 've_o' })), []);
});

test('search combines with filters and explicit sort', async () => {
  const res = await call(ballsHandler, { search: 'phaze', weight: '15', sort: 'release_date,desc' });
  assert.deepEqual(ids(res), ['2-15', '1-15']);
});

test('GET /api/balls/{id} returns all variants heaviest first, or 404', async () => {
  const res = await call(ballHandler, { id: '1' });
  assert.deepEqual(
    res.body.map((b) => b.core_weight),
    ['15', '14'],
  );
  assert.equal((await call(ballHandler, { id: '1', weight: '14' })).body.length, 1);
  assert.equal((await call(ballHandler, { id: 'nope' })).statusCode, 404);
});

test('GET /api/balls/{id}/similar finds same-weight balls within tolerance', async () => {
  const res = await call(similarHandler, { id: '1', weight: '15' });
  // ball 1: rg 2.48 / diff 0.051 → 2 (2.49/0.052) and 6 (2.50/0.055) qualify; 7 is too far, 8 has another coverstock
  assert.deepEqual(
    res.body.map((b) => b.ball_id),
    ['6', '2'],
  );
  assert.equal((await call(similarHandler, { id: '1', weight: '15', limit: '1' })).body.length, 1);
  assert.deepEqual((await call(similarHandler, { id: '4' })).body, [], 'no specs → nothing similar');
  assert.equal((await call(similarHandler, { id: 'nope' })).statusCode, 404);
});

test('catalog lists stay plain arrays and page on request', async () => {
  const brands = await call(brandsHandler);
  assert.deepEqual(
    brands.body.map((b) => b.brand_name),
    ['Hammer', 'Motiv', 'Storm'],
  );
  const cores = await call(coresHandler, { brand: 'storm', size: '5' });
  assert.deepEqual(
    cores.body.content.map((c) => c.core_name),
    ['Velocity'],
  );
  assert.equal(cores.body.page.totalElements, 1);
  assert.deepEqual(
    (await call(coresHandler, { search: 'gas' })).body.map((c) => c.core_name),
    ['Gas Mask'],
  );
});

test('health reports counts and the last sync', async () => {
  const res = await call(healthHandler);
  assert.equal(res.body.counts.balls, 8);
  assert.equal(res.body.lastSync.status, 'success');
});

test('cron endpoint requires the secret', async () => {
  delete process.env.CRON_SECRET;
  assert.equal((await call(cronHandler)).statusCode, 500);

  process.env.CRON_SECRET = 'test-secret';
  assert.equal((await call(cronHandler)).statusCode, 401);
  assert.equal((await call(cronHandler, {}, { headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
});

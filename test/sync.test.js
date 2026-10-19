import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../lib/db.js';
import { runSync } from '../lib/sync.js';
import { BALLS_15, fakeUpstream, upstreamBall } from './helpers/fixtures.js';
import { resetDatabase, startDatabase } from './helpers/db.js';

let stop;
before(async () => {
  stop = await startDatabase();
});
after(() => stop());
beforeEach(() => resetDatabase());

const sync = (data, extra = {}) => runSync({ weights: [14, 15], fetchFn: fakeUpstream(data).fetchFn, retryBackoffMs: 1, log: () => {}, ...extra });
const count = async (sql) => (await query(sql)).rows[0].n;

test('first sync inserts everything and logs a successful run', async () => {
  const run = await sync();
  assert.equal(run.status, 'success');
  assert.equal(run.stats.balls_15.inserted, 4);
  assert.equal(run.stats.balls_14.inserted, 1);
  assert.equal(run.stats.brands.inserted, 3);
  assert.equal(await count('SELECT count(*)::int AS n FROM balls'), 5);

  const { rows } = await query(`SELECT * FROM balls WHERE ball_id = '3'`);
  assert.equal(Number(rows[0].core_rg), 2.5);
  assert.equal(rows[0].weight, '15');
  assert.equal(rows[0].release_date, '2022-03-01');
  assert.equal(rows[0].raw.ball_name, 'Black Widow 3.0');
});

test('unparsable numbers become NULL but the raw value is kept', async () => {
  await sync();
  const { rows } = await query(`SELECT core_rg, raw->>'core_rg' AS raw_rg FROM balls WHERE ball_id = '4'`);
  assert.deepEqual(rows[0], { core_rg: null, raw_rg: 'n/a' });
});

test('a repeat sync with unchanged data writes nothing', async () => {
  await sync();
  const run = await sync();
  assert.equal(run.stats.balls_15.inserted + run.stats.balls_15.updated, 0);
  assert.equal(run.stats.brands.updated, 0);
});

test('changed balls are updated, new balls inserted, first_seen_at kept', async () => {
  await sync();
  const { rows: before } = await query(`SELECT first_seen_at FROM balls WHERE ball_id = '2'`);

  const changed = BALLS_15.map((b) => (b.ball_id === '2' ? { ...b, availability: 'Discontinued' } : b));
  const run = await sync({ 15: [...changed, upstreamBall({ ball_id: '5', ball_name: 'New Ball', release_date: '2026-10-01' })] });

  assert.equal(run.stats.balls_15.updated, 1);
  assert.equal(run.stats.balls_15.inserted, 1);
  const { rows } = await query(`SELECT availability, first_seen_at FROM balls WHERE ball_id = '2'`);
  assert.equal(rows[0].availability, 'Discontinued');
  assert.deepEqual(rows[0].first_seen_at, before[0].first_seen_at);
});

test('balls missing upstream are soft-deleted and restored when they return', async () => {
  await sync();
  const run = await sync({ 15: BALLS_15.slice(0, 3) });
  assert.equal(run.stats.balls_15.removed, 1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM balls WHERE removed_at IS NOT NULL`), 1);
  // the 14 lb variant of ball 1 is untouched by the 15 lb list
  assert.equal(await count(`SELECT count(*)::int AS n FROM balls WHERE ball_id = '1' AND removed_at IS NULL`), 2);

  const back = await sync();
  assert.equal(back.stats.balls_15.updated, 1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM balls WHERE removed_at IS NOT NULL`), 0);
});

test('a suspiciously small response does not remove anything', async () => {
  await sync();
  const run = await sync({ 15: BALLS_15.slice(0, 1) });
  assert.equal(run.stats.balls_15.removed, 0);
  assert.match(run.stats.warnings.join(), /skipped removal/);
  assert.equal(await count(`SELECT count(*)::int AS n FROM balls WHERE removed_at IS NOT NULL`), 0);
});

test('one failing part makes the run partial without touching existing data', async () => {
  await sync();
  const run = await sync({ 15: new Error('connection reset') });
  assert.equal(run.status, 'partial');
  assert.match(run.errors[0], /balls_15/);
  assert.equal(run.stats.balls_14.fetched, 1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM balls WHERE removed_at IS NULL`), 5);
});

test('a run is skipped while another one is running; stale runs are closed out', async () => {
  await query(`INSERT INTO sync_runs (status, trigger) VALUES ('running', 'cron')`);
  assert.deepEqual(await sync(), { skipped: true });

  await query(`UPDATE sync_runs SET started_at = now() - interval '1 hour'`);
  const run = await sync();
  assert.equal(run.status, 'success');
  const { rows } = await query(`SELECT status FROM sync_runs ORDER BY id`);
  assert.deepEqual(
    rows.map((r) => r.status),
    ['failed', 'success'],
  );
});

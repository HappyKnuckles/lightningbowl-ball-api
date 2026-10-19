import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../lib/db.js';
import { startDatabase } from './helpers/db.js';

let stop;
before(async () => {
  stop = await startDatabase();
});
after(() => stop());

async function contribute(install, { arsenal = [], games = [] }) {
  await query('INSERT INTO stat_contributors (install_hash) VALUES ($1)', [install]);
  for (const ballId of arsenal) await query('INSERT INTO stat_arsenal VALUES ($1, $2)', [install, ballId]);
  for (const g of games) {
    await query(
      'INSERT INTO stat_ball_games (install_hash, ball_id, games, total_score, high_score, strikes, spares) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [install, g.ballId, g.games, g.total, g.high, g.strikes ?? 0, g.spares ?? 0],
    );
  }
}

test('ball_stats counts arsenals and hides scores below 3 bowlers', async () => {
  await contribute('a', { arsenal: ['1', '2'], games: [{ ballId: '1', games: 10, total: 2000, high: 250, strikes: 40, spares: 30 }] });
  await contribute('b', { arsenal: ['1'], games: [{ ballId: '1', games: 5, total: 900, high: 210 }] });

  let { rows } = await query(`SELECT * FROM ball_stats WHERE ball_id = '1'`);
  assert.equal(rows[0].arsenal_count, 2);
  assert.equal(rows[0].bowlers, 2);
  assert.equal(rows[0].average_score, null);

  await contribute('c', { games: [{ ballId: '1', games: 5, total: 1100, high: 279, strikes: 20, spares: 10 }] });
  ({ rows } = await query(`SELECT * FROM ball_stats WHERE ball_id = '1'`));
  assert.equal(rows[0].bowlers, 3);
  assert.equal(rows[0].games, 20);
  assert.equal(rows[0].average_score, '200.0');
  assert.equal(rows[0].high_score, 279);
  assert.equal(rows[0].strikes_per_game, '3.00');

  ({ rows } = await query(`SELECT * FROM ball_stats WHERE ball_id = '2'`));
  assert.deepEqual([rows[0].arsenal_count, rows[0].games], [1, 0]);
});

test('impossible numbers are rejected by constraints', async () => {
  await query(`INSERT INTO stat_contributors (install_hash) VALUES ('d')`);
  await assert.rejects(query(`INSERT INTO stat_ball_games (install_hash, ball_id, games, total_score, high_score) VALUES ('d', '1', 1, 301, 301)`));
  await assert.rejects(
    query(`INSERT INTO stat_ball_games (install_hash, ball_id, games, total_score, high_score, strikes) VALUES ('d', '1', 1, 300, 300, 13)`),
  );
});

test('deleting a contributor removes their data', async () => {
  await query(`DELETE FROM stat_contributors WHERE install_hash = 'a'`);
  const { rows } = await query(`SELECT arsenal_count FROM ball_stats WHERE ball_id = '2'`);
  assert.equal(rows.length, 0);
});

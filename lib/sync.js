// Nightly import of the bowwwl.com catalog into Postgres.
//
// - Inserts new rows, updates rows whose upstream data changed, leaves
//   unchanged rows untouched.
// - Rows missing upstream are soft-deleted (`removed_at`) and restored if they
//   come back. Removal is skipped when a response looks truncated, so a bad
//   upstream day can't wipe the catalog.
// - Each part (brands, cores, coverstocks, each weight) is independent: one
//   failing part doesn't stop the others. The run is logged in `sync_runs`.

import { query } from './db.js';
import { ballKey, normalizeBall, normalizeBrand, normalizeCore, normalizeCoverstock } from './normalize.js';
import { fetchList } from './upstream.js';

export const DEFAULT_WEIGHTS = [12, 13, 14, 15, 16];

/** Removal only happens if the fetch returned at least this share of the active rows. */
const MIN_REMOVAL_RATIO = 0.5;
const BATCH_SIZE = 500;
const STALE_RUN_MS = 30 * 60 * 1000;

export function configuredWeights() {
  const env = process.env.SYNC_WEIGHTS;
  if (!env) return DEFAULT_WEIGHTS;
  const weights = env
    .split(',')
    .map((w) => Number(w.trim()))
    .filter((w) => Number.isFinite(w) && w > 0);
  return weights.length > 0 ? weights : DEFAULT_WEIGHTS;
}

function dedupe(rows, keyOf) {
  const map = new Map();
  for (const row of rows) map.set(keyOf(row), row);
  return [...map.values()];
}

function chunks(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

/** Counts inserted vs updated rows from `RETURNING (xmax = 0) AS inserted`. */
function tally(stats, rows) {
  for (const { inserted } of rows) {
    if (inserted) stats.inserted++;
    else stats.updated++;
  }
}

// ---------------------------------------------------------------- reference

const REFERENCE_TABLES = {
  brands: { path: '/brands', normalize: normalizeBrand, hasBrand: false },
  cores: { path: '/cores', normalize: normalizeCore, hasBrand: true },
  coverstocks: { path: '/coverstocks', normalize: normalizeCoverstock, hasBrand: true },
};

async function upsertReference(table, rows, hasBrand) {
  const columns = hasBrand ? 'id, name, brand, raw' : 'id, name, raw';
  const recordset = hasBrand ? 'id text, name text, brand text, raw jsonb' : 'id text, name text, raw jsonb';
  const updates = hasBrand ? 'name = EXCLUDED.name, brand = EXCLUDED.brand,' : 'name = EXCLUDED.name,';

  const result = await query(
    `INSERT INTO ${table} (${columns})
     SELECT ${columns} FROM jsonb_to_recordset($1::jsonb) AS x(${recordset})
     ON CONFLICT (id) DO UPDATE SET ${updates}
       raw = EXCLUDED.raw, updated_at = now(), removed_at = NULL
     WHERE ${table}.raw IS DISTINCT FROM EXCLUDED.raw OR ${table}.removed_at IS NOT NULL
     RETURNING (xmax = 0) AS inserted`,
    [JSON.stringify(rows)],
  );
  return result.rows;
}

async function syncReference(name, { fetchOptions, warnings }) {
  const { path, normalize, hasBrand } = REFERENCE_TABLES[name];
  const stats = { fetched: 0, skipped: 0, inserted: 0, updated: 0, removed: 0 };

  const data = await fetchList(path, fetchOptions);
  const rows = dedupe(data.map(normalize).filter(Boolean), (r) => r.id);
  stats.fetched = data.length;
  stats.skipped = data.length - rows.length;

  for (const batch of chunks(rows, BATCH_SIZE)) {
    tally(stats, await upsertReference(name, batch, hasBrand));
  }

  const { rows: activeRows } = await query(`SELECT count(*)::int AS n FROM ${name} WHERE removed_at IS NULL`);
  if (rows.length >= activeRows[0].n * MIN_REMOVAL_RATIO && rows.length > 0) {
    const removed = await query(`UPDATE ${name} SET removed_at = now() WHERE removed_at IS NULL AND NOT (id = ANY($1::text[]))`, [
      rows.map((r) => r.id),
    ]);
    stats.removed = removed.rowCount;
  } else {
    warnings.push(`${name}: got ${rows.length} rows for ${activeRows[0].n} active, skipped removal`);
  }

  return stats;
}

// -------------------------------------------------------------------- balls

const BALL_COLUMNS = [
  ['ball_id', 'text'],
  ['core_weight', 'text'],
  ['weight', 'numeric'],
  ['ball_name', 'text'],
  ['brand_id', 'text'],
  ['brand_name', 'text'],
  ['core_id', 'text'],
  ['core_name', 'text'],
  ['core_type', 'text'],
  ['core_rg', 'numeric'],
  ['core_diff', 'numeric'],
  ['core_int_diff', 'numeric'],
  ['coverstock_id', 'text'],
  ['coverstock_name', 'text'],
  ['coverstock_type', 'text'],
  ['factory_finish', 'text'],
  ['availability', 'text'],
  ['us_int', 'text'],
  ['release_date', 'date'],
  ['raw', 'jsonb'],
];

const BALL_COLUMN_LIST = BALL_COLUMNS.map(([c]) => c).join(', ');
const BALL_RECORDSET = BALL_COLUMNS.map(([c, t]) => `${c} ${t}`).join(', ');
const BALL_UPDATES = BALL_COLUMNS.filter(([c]) => c !== 'ball_id' && c !== 'core_weight')
  .map(([c]) => `${c} = EXCLUDED.${c}`)
  .join(', ');

async function upsertBalls(rows) {
  const result = await query(
    `INSERT INTO balls (${BALL_COLUMN_LIST})
     SELECT ${BALL_COLUMN_LIST} FROM jsonb_to_recordset($1::jsonb) AS x(${BALL_RECORDSET})
     ON CONFLICT (ball_id, core_weight) DO UPDATE SET ${BALL_UPDATES}, updated_at = now(), removed_at = NULL
     WHERE balls.raw IS DISTINCT FROM EXCLUDED.raw OR balls.removed_at IS NOT NULL
     RETURNING (xmax = 0) AS inserted`,
    [JSON.stringify(rows)],
  );
  return result.rows;
}

async function syncWeight(weight, { fetchOptions, warnings }) {
  const stats = { fetched: 0, skipped: 0, inserted: 0, updated: 0, removed: 0 };

  const params = new URLSearchParams({ _format: 'json', weight: String(weight) });
  const data = await fetchList(`/balls?${params}`, { timeoutMs: 60000, ...fetchOptions });
  const rows = dedupe(data.map(normalizeBall).filter(Boolean), ballKey);
  stats.fetched = data.length;
  stats.skipped = data.length - rows.length;

  for (const batch of chunks(rows, BATCH_SIZE)) {
    tally(stats, await upsertBalls(batch));
  }

  // Remove only within the weight that was fetched.
  const inWeight = rows.filter((r) => r.weight === weight);
  const { rows: activeRows } = await query('SELECT count(*)::int AS n FROM balls WHERE weight = $1 AND removed_at IS NULL', [weight]);
  const active = activeRows[0].n;

  if (inWeight.length > 0 && inWeight.length >= active * MIN_REMOVAL_RATIO) {
    const removed = await query(
      `UPDATE balls SET removed_at = now()
       WHERE weight = $1 AND removed_at IS NULL AND NOT ((ball_id || '|' || core_weight) = ANY($2::text[]))`,
      [weight, inWeight.map(ballKey)],
    );
    stats.removed = removed.rowCount;
  } else if (active > 0) {
    warnings.push(`balls ${weight} lb: got ${inWeight.length} rows for ${active} active, skipped removal`);
  }

  return stats;
}

// ---------------------------------------------------------------------- run

/**
 * Runs a full sync. Returns the finished `sync_runs` row, or
 * `{ skipped: true }` if another run is still in progress.
 */
export async function runSync({ trigger = 'manual', weights = configuredWeights(), fetchFn = fetch, retryBackoffMs, log = console.log } = {}) {
  const fetchOptions = { fetchFn, ...(retryBackoffMs !== undefined && { backoffMs: retryBackoffMs }) };
  // Runs that never finished (crashed function, timeout) are closed out.
  await query(
    `UPDATE sync_runs SET status = 'failed', finished_at = now(), errors = errors || '["did not finish"]'::jsonb
     WHERE status = 'running' AND started_at < now() - $1::interval`,
    [`${STALE_RUN_MS} milliseconds`],
  );

  const { rows: started } = await query(
    `INSERT INTO sync_runs (status, trigger)
     SELECT 'running', $1
     WHERE NOT EXISTS (SELECT 1 FROM sync_runs WHERE status = 'running')
     RETURNING id`,
    [trigger],
  );
  if (started.length === 0) {
    log('Another sync is running, skipping');
    return { skipped: true };
  }
  const runId = started[0].id;

  const stats = {};
  const errors = [];
  const warnings = [];
  const parts = [
    ...Object.keys(REFERENCE_TABLES).map((name) => [name, () => syncReference(name, { fetchOptions, warnings })]),
    ...weights.map((w) => [`balls_${w}`, () => syncWeight(w, { fetchOptions, warnings })]),
  ];

  for (const [name, fn] of parts) {
    try {
      stats[name] = await fn();
      log(`${name}: ${JSON.stringify(stats[name])}`);
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
      log(`${name} failed: ${error.message}`);
    }
  }

  if (warnings.length > 0) stats.warnings = warnings;
  const status = errors.length === 0 ? 'success' : errors.length === parts.length ? 'failed' : 'partial';

  const { rows } = await query(
    `UPDATE sync_runs SET status = $2, finished_at = now(), stats = $3::jsonb, errors = $4::jsonb
     WHERE id = $1 RETURNING *`,
    [runId, status, JSON.stringify(stats), JSON.stringify(errors)],
  );
  return rows[0];
}

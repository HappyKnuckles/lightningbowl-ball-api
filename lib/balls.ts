// Ball queries: filtering, fuzzy search, sorting and paging run in Postgres.

import { query, withTransaction } from './db.js';
import { escapeLike, pageOf, SqlParams } from './params.js';
import { type Ball, type BallPage, type BallQuery, type BallSortField, sortOrders } from './schemas.js';

/** Sort field → SQL expression (matches the indexes in 001_init.sql). */
const SORT_SQL: Record<BallSortField, string> = {
  ball_name: 'lower(ball_name)',
  brand_name: 'lower(brand_name)',
  release_date: 'release_date',
  first_seen_at: 'first_seen_at',
  core_rg: 'core_rg',
  core_diff: 'core_diff',
  core_int_diff: 'core_int_diff',
  core_type: 'lower(core_type)',
  coverstock_type: 'lower(coverstock_type)',
  factory_finish: 'lower(factory_finish)',
  weight: 'weight',
};

const DEFAULT_SORT: { field: BallSortField; direction: 'asc' | 'desc' }[] = [
  { field: 'release_date', direction: 'desc' },
  { field: 'ball_name', direction: 'asc' },
];

/** Minimum word similarity (0–1) for a fuzzy search hit. 0.45 tolerates one typo in a short word. */
const SEARCH_THRESHOLD = 0.45;

/** Columns searched, with the same relative weights the app used with Fuse.js. */
const SEARCH_COLUMNS: [column: string, weight: number][] = [
  ['ball_name', 1],
  ['brand_name', 0.9],
  ['core_name', 0.7],
  ['coverstock_name', 0.7],
  ['factory_finish', 0.5],
];

/** What the API returns per ball: the upstream object plus when we first saw it. */
const BALL_JSON = `raw || jsonb_build_object('first_seen_at', first_seen_at)`;

/** Comma-separated search terms, lower-cased, at most 10. */
export function searchTerms(search: string | undefined): string[] {
  return (search ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 10);
}

/** Builds WHERE, relevance and ORDER BY clauses for a parsed query. */
export function buildBallSql(o: BallQuery) {
  const p = new SqlParams();
  const where = ['removed_at IS NULL'];

  const lowerIn = (column: string, values: string[]) => {
    if (values.length > 0) where.push(`lower(${column}) = ANY(${p.add(values.map((v) => v.toLowerCase()))}::text[])`);
  };
  const range = (column: string, min: number | string | undefined, max: number | string | undefined) => {
    if (min !== undefined) where.push(`${column} >= ${p.add(min)}`);
    if (max !== undefined) where.push(`${column} <= ${p.add(max)}`);
  };

  if (o.weight !== undefined) where.push(`weight = ${p.add(o.weight)}`);
  lowerIn('brand_name', o.brand);
  lowerIn('core_name', o.core);
  lowerIn('coverstock_name', o.coverstock);
  lowerIn('coverstock_type', o.coverstockType);
  lowerIn('factory_finish', o.factoryFinish);
  if (o.id.length > 0) where.push(`ball_id = ANY(${p.add(o.id)}::text[])`);
  if (o.excludeId.length > 0) where.push(`NOT (ball_id = ANY(${p.add(o.excludeId)}::text[]))`);
  if (o.market) where.push(`us_int = ${p.add(o.market)}`);
  if (o.coreType) where.push(`core_type = ${p.add(o.coreType)}`);
  if (o.available === true) where.push(`availability = 'Available'`);
  if (o.available === false) where.push(`availability IS DISTINCT FROM 'Available'`);
  if (o.releaseDate) where.push(`raw->>'release_date' = ${p.add(o.releaseDate)}`);
  range('release_date', o.releasedAfter, o.releasedBefore);
  if (o.addedAfter) where.push(`first_seen_at >= ${p.add(o.addedAfter)}::date`);
  range('core_rg', o.minRg, o.maxRg);
  range('core_diff', o.minDiff, o.maxDiff);
  range('core_int_diff', o.minIntDiff, o.maxIntDiff);

  let relevance: string | null = null;
  const terms = searchTerms(o.search);
  if (terms.length > 0) {
    const matches: string[] = [];
    const scores: string[] = [];
    for (const term of terms) {
      const t = p.add(term);
      const like = p.add(`%${escapeLike(term)}%`);
      // `<%` (word similarity) and LIKE both use the trigram index on search_text.
      matches.push(`${t} <% search_text OR search_text LIKE ${like}`);
      scores.push(`GREATEST(${SEARCH_COLUMNS.map(([col, w]) => `${w} * word_similarity(${t}, lower(coalesce(${col}, '')))`).join(', ')})`);
    }
    where.push(`(${matches.join(' OR ')})`);
    relevance = scores.length === 1 ? scores[0]! : `GREATEST(${scores.join(", ")})`;
  }

  // With a search and no explicit sort, best matches come first.
  const explicit = sortOrders<BallSortField>(o.sort);
  const orders =
    explicit.length > 0
      ? explicit.map(({ field, direction }) => `${SORT_SQL[field]} ${direction.toUpperCase()} NULLS LAST`)
      : relevance
        ? ['relevance DESC']
        : DEFAULT_SORT.map(({ field, direction }) => `${SORT_SQL[field]} ${direction.toUpperCase()} NULLS LAST`);
  orders.push('ball_id', 'core_weight'); // deterministic paging

  return { where: where.join(' AND '), relevance, orderBy: orders.join(', '), params: p.values };
}

export async function findBalls(options: BallQuery): Promise<BallPage> {
  const { where, relevance, orderBy, params } = buildBallSql(options);
  const limit = `$${params.length + 1}`;
  const offset = `$${params.length + 2}`;

  return withTransaction(async (client) => {
    if (relevance) {
      await client.query(`SET LOCAL pg_trgm.word_similarity_threshold = ${SEARCH_THRESHOLD}`);
      // The planner over-estimates trigram GIN scans at catalog size and picks a
      // seq scan (~70 ms on 10k rows) over the index (~4 ms). Only affects this
      // transaction.
      await client.query('SET LOCAL enable_seqscan = off');
    }
    const [{ rows: countRows }, { rows }] = await Promise.all([
      client.query<{ total: number }>(`SELECT count(*)::int AS total FROM balls WHERE ${where}`, params),
      client.query<{ ball: Ball }>(
        `SELECT ${BALL_JSON} AS ball${relevance ? `, ${relevance} AS relevance` : ''}
         FROM balls WHERE ${where} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`,
        [...params, options.size, options.page * options.size],
      ),
    ]);
    return pageOf(
      rows.map((r) => r.ball),
      options,
      countRows[0]?.total ?? 0,
    );
  });
}

/** All weight variants of a ball (heaviest first), including removed ones. */
export async function findBallVariants(ballId: string, weight?: number): Promise<Ball[]> {
  const params: unknown[] = [ballId];
  let sql = `SELECT ${BALL_JSON} || jsonb_build_object('removed_at', removed_at) AS ball FROM balls WHERE ball_id = $1`;
  if (weight !== undefined) {
    params.push(weight);
    sql += ' AND weight = $2';
  }
  const { rows } = await query<{ ball: Ball }>(`${sql} ORDER BY weight DESC NULLS LAST, core_weight`, params);
  return rows.map((r) => r.ball);
}

const RG_TOLERANCE = 0.03;
const DIFF_TOLERANCE = 0.008;
const INT_DIFF_TOLERANCE = 0.005;

/**
 * Balls of the same weight with a similar expected reaction: same core type
 * and coverstock type, RG and differential within tolerance, plus
 * intermediate differential for asymmetric cores. Newest first.
 * Returns null if the reference ball doesn't exist.
 */
interface ReferenceBall {
  ball_id: string;
  weight: string | null;
  core_type: string | null;
  coverstock_type: string | null;
  core_rg: string | null;
  core_diff: string | null;
  core_int_diff: string | null;
}

export async function findSimilarBalls(ballId: string, weight: number | undefined, limit: number): Promise<Ball[] | null> {
  const { rows: refs } = await query<ReferenceBall>(
    `SELECT ball_id, core_weight, weight, core_type, coverstock_type, core_rg, core_diff, core_int_diff
     FROM balls WHERE ball_id = $1 AND ($2::numeric IS NULL OR weight = $2)
     ORDER BY removed_at NULLS FIRST, weight DESC NULLS LAST LIMIT 1`,
    [ballId, weight ?? null],
  );
  const ref = refs[0];
  if (!ref) return null;
  if (ref.core_rg === null || ref.core_diff === null || ref.weight === null) return [];

  const asymmetric = ref.core_type === 'Asymmetric';
  if (asymmetric && ref.core_int_diff === null) return [];

  const params: unknown[] = [ref.weight, ref.core_type, ref.coverstock_type, ref.core_rg, RG_TOLERANCE, ref.core_diff, DIFF_TOLERANCE, ref.ball_id, limit];
  let intDiff = '';
  if (asymmetric) {
    params.push(ref.core_int_diff, INT_DIFF_TOLERANCE);
    intDiff = `AND core_int_diff BETWEEN $10::numeric - $11 AND $10::numeric + $11`;
  }

  const { rows } = await query<{ ball: Ball }>(
    `SELECT ${BALL_JSON} AS ball FROM balls
     WHERE removed_at IS NULL
       AND weight = $1 AND core_type IS NOT DISTINCT FROM $2 AND coverstock_type IS NOT DISTINCT FROM $3
       AND core_rg BETWEEN $4::numeric - $5 AND $4::numeric + $5
       AND core_diff BETWEEN $6::numeric - $7 AND $6::numeric + $7
       ${intDiff}
       AND ball_id <> $8
     ORDER BY release_date DESC NULLS LAST, lower(ball_name), ball_id
     LIMIT $9`,
    params,
  );
  return rows.map((r) => r.ball);
}

/** Every active ball (optionally one weight), newest first. */
export async function exportBalls(weight?: number): Promise<Ball[]> {
  const { rows } = await query<{ ball: Ball }>(
    `SELECT ${BALL_JSON} AS ball FROM balls
     WHERE removed_at IS NULL AND ($1::numeric IS NULL OR weight = $1)
     ORDER BY release_date DESC NULLS LAST, lower(ball_name), ball_id, core_weight`,
    [weight ?? null],
  );
  return rows.map((r) => r.ball);
}

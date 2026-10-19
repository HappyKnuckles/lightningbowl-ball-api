// Ball queries: filtering, fuzzy search, sorting and paging run in Postgres.

import { query, withTransaction } from './db.js';
import {
  BadRequestError,
  escapeLike,
  pageOf,
  parseBoolean,
  parseDate,
  parseEnum,
  parseList,
  parseNumber,
  parsePageable,
  parseSort,
  parseString,
} from './params.js';

export const MARKETS = ['US', 'Overseas'];
export const CORE_TYPES = ['Symmetric', 'Asymmetric'];

/** Public sort field → SQL expression (matches the indexes in 001_init.sql). */
export const BALL_SORT_FIELDS = {
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

const DEFAULT_SORT = [
  { field: 'release_date', direction: 'desc' },
  { field: 'ball_name', direction: 'asc' },
];

/** Minimum word similarity (0–1) for a fuzzy search hit. 0.45 tolerates one typo in a short word. */
const SEARCH_THRESHOLD = 0.45;

/** Columns searched, with the same relative weights the app used with Fuse.js. */
const SEARCH_COLUMNS = [
  ['ball_name', 1],
  ['brand_name', 0.9],
  ['core_name', 0.7],
  ['coverstock_name', 0.7],
  ['factory_finish', 0.5],
];

/** What the API returns per ball: the upstream object plus when we first saw it. */
const BALL_JSON = `raw || jsonb_build_object('first_seen_at', first_seen_at)`;

export function parseBallQuery(q) {
  const search = parseString('search', q.search ?? q.q);
  const options = {
    searchTerms: search
      ? search
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 10)
      : [],
    weight: parseNumber('weight', q.weight, { min: 0, max: 20 }),
    brands: parseList('brand', q.brand),
    cores: parseList('core', q.core),
    coverstocks: parseList('coverstock', q.coverstock),
    coverstockTypes: parseList('coverstockType', q.coverstockType),
    factoryFinishes: parseList('factoryFinish', q.factoryFinish),
    ids: parseList('id', q.id),
    excludeIds: parseList('excludeId', q.excludeId),
    market: parseEnum('market', q.market, MARKETS),
    coreType: parseEnum('coreType', q.coreType, CORE_TYPES),
    available: parseBoolean('available', q.available),
    releaseDate: parseString('releaseDate', q.releaseDate),
    releasedAfter: parseDate('releasedAfter', q.releasedAfter),
    releasedBefore: parseDate('releasedBefore', q.releasedBefore),
    addedAfter: parseDate('addedAfter', q.addedAfter),
    minRg: parseNumber('minRg', q.minRg),
    maxRg: parseNumber('maxRg', q.maxRg),
    minDiff: parseNumber('minDiff', q.minDiff),
    maxDiff: parseNumber('maxDiff', q.maxDiff),
    minIntDiff: parseNumber('minIntDiff', q.minIntDiff),
    maxIntDiff: parseNumber('maxIntDiff', q.maxIntDiff),
    sort: parseSort(q.sort, BALL_SORT_FIELDS),
    ...parsePageable(q),
  };

  for (const [min, max] of [
    ['minRg', 'maxRg'],
    ['minDiff', 'maxDiff'],
    ['minIntDiff', 'maxIntDiff'],
    ['releasedAfter', 'releasedBefore'],
  ]) {
    if (options[min] !== undefined && options[max] !== undefined && options[min] > options[max]) {
      throw new BadRequestError(`"${min}" must not be greater than "${max}"`);
    }
  }

  return options;
}

/** Collects bind parameters and hands out their `$n` placeholders. */
class Params {
  values = [];
  add(value) {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** Builds WHERE, relevance and ORDER BY clauses for a parsed query. */
export function buildBallSql(o) {
  const p = new Params();
  const where = ['removed_at IS NULL'];

  const lowerIn = (column, values) => {
    if (values.length > 0) where.push(`lower(${column}) = ANY(${p.add(values.map((v) => v.toLowerCase()))}::text[])`);
  };
  const range = (column, min, max) => {
    if (min !== undefined) where.push(`${column} >= ${p.add(min)}`);
    if (max !== undefined) where.push(`${column} <= ${p.add(max)}`);
  };

  if (o.weight !== undefined) where.push(`weight = ${p.add(o.weight)}`);
  lowerIn('brand_name', o.brands);
  lowerIn('core_name', o.cores);
  lowerIn('coverstock_name', o.coverstocks);
  lowerIn('coverstock_type', o.coverstockTypes);
  lowerIn('factory_finish', o.factoryFinishes);
  if (o.ids.length > 0) where.push(`ball_id = ANY(${p.add(o.ids)}::text[])`);
  if (o.excludeIds.length > 0) where.push(`NOT (ball_id = ANY(${p.add(o.excludeIds)}::text[]))`);
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

  let relevance = null;
  if (o.searchTerms.length > 0) {
    const matches = [];
    const scores = [];
    for (const term of o.searchTerms) {
      const t = p.add(term);
      const like = p.add(`%${escapeLike(term)}%`);
      // `<%` (word similarity) and LIKE both use the trigram index on search_text.
      matches.push(`${t} <% search_text OR search_text LIKE ${like}`);
      scores.push(`GREATEST(${SEARCH_COLUMNS.map(([col, w]) => `${w} * word_similarity(${t}, lower(coalesce(${col}, '')))`).join(', ')})`);
    }
    where.push(`(${matches.join(' OR ')})`);
    relevance = scores.length === 1 ? scores[0] : `GREATEST(${scores.join(', ')})`;
  }

  // With a search and no explicit sort, best matches come first.
  const orders =
    o.sort.length > 0
      ? o.sort.map(({ field, direction }) => `${BALL_SORT_FIELDS[field]} ${direction.toUpperCase()} NULLS LAST`)
      : relevance
        ? ['relevance DESC']
        : DEFAULT_SORT.map(({ field, direction }) => `${BALL_SORT_FIELDS[field]} ${direction.toUpperCase()} NULLS LAST`);
  orders.push('ball_id', 'core_weight'); // deterministic paging

  return { where: where.join(' AND '), relevance, orderBy: orders.join(', '), params: p.values };
}

export async function findBalls(options) {
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
      client.query(`SELECT count(*)::int AS total FROM balls WHERE ${where}`, params),
      client.query(
        `SELECT ${BALL_JSON} AS ball${relevance ? `, ${relevance} AS relevance` : ''}
         FROM balls WHERE ${where} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`,
        [...params, options.size, options.page * options.size],
      ),
    ]);
    return pageOf(
      rows.map((r) => r.ball),
      options,
      countRows[0].total,
    );
  });
}

/** All weight variants of a ball (heaviest first), including removed ones. */
export async function findBallVariants(ballId, weight) {
  const params = [ballId];
  let sql = `SELECT ${BALL_JSON} || jsonb_build_object('removed_at', removed_at) AS ball FROM balls WHERE ball_id = $1`;
  if (weight !== undefined) {
    params.push(weight);
    sql += ' AND weight = $2';
  }
  const { rows } = await query(`${sql} ORDER BY weight DESC NULLS LAST, core_weight`, params);
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
export async function findSimilarBalls(ballId, weight, limit) {
  const { rows: refs } = await query(
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

  const params = [ref.weight, ref.core_type, ref.coverstock_type, ref.core_rg, RG_TOLERANCE, ref.core_diff, DIFF_TOLERANCE, ref.ball_id, limit];
  let intDiff = '';
  if (asymmetric) {
    params.push(ref.core_int_diff, INT_DIFF_TOLERANCE);
    intDiff = `AND core_int_diff BETWEEN $10::numeric - $11 AND $10::numeric + $11`;
  }

  const { rows } = await query(
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

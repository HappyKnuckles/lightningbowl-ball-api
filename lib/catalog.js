// Reference lists (brands, cores, coverstocks): search, brand filter, sort and
// optional paging. Without page/size a plain array is returned, like the proxy.
import { query } from './db.js';
import { escapeLike, pageOf, parseList, parsePageable, parseSort, parseString, wantsPaging } from './params.js';

export const CATALOGS = {
  brands: {
    searchExpr: 'lower(name)',
    sortFields: { brand_name: 'lower(name)' },
    defaultOrder: 'lower(name)',
    hasBrand: false,
  },
  cores: {
    searchExpr: `lower(name) || ' ' || lower(coalesce(brand, ''))`,
    sortFields: { core_name: 'lower(name)', brand: 'lower(brand)' },
    defaultOrder: 'lower(brand), lower(name)',
    hasBrand: true,
  },
  coverstocks: {
    searchExpr: `lower(name) || ' ' || lower(coalesce(brand, ''))`,
    sortFields: { coverstock_name: 'lower(name)', brand: 'lower(brand)' },
    defaultOrder: 'lower(brand), lower(name)',
    hasBrand: true,
  },
};

export async function findCatalog(table, q) {
  const config = CATALOGS[table];
  const search = parseString('search', q.search ?? q.q);
  const brands = config.hasBrand ? parseList('brand', q.brand) : [];
  const sort = parseSort(q.sort, config.sortFields);
  const paging = wantsPaging(q) ? parsePageable(q) : null;

  const params = [];
  const where = ['removed_at IS NULL'];
  if (search) {
    params.push(`%${escapeLike(search.toLowerCase())}%`);
    where.push(`${config.searchExpr} LIKE $${params.length}`);
  }
  if (brands.length > 0) {
    params.push(brands.map((b) => b.toLowerCase()));
    where.push(`lower(brand) = ANY($${params.length}::text[])`);
  }

  const orderBy =
    (sort.length > 0 ? sort.map((s) => `${config.sortFields[s.field]} ${s.direction.toUpperCase()} NULLS LAST`).join(', ') : config.defaultOrder) +
    ', id';
  const whereSql = where.join(' AND ');

  if (!paging) {
    const { rows } = await query(`SELECT raw FROM ${table} WHERE ${whereSql} ORDER BY ${orderBy}`, params);
    return rows.map((r) => r.raw);
  }

  const [{ rows: countRows }, { rows }] = await Promise.all([
    query(`SELECT count(*)::int AS total FROM ${table} WHERE ${whereSql}`, params),
    query(`SELECT raw FROM ${table} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
      ...params,
      paging.size,
      paging.page * paging.size,
    ]),
  ]);
  return pageOf(
    rows.map((r) => r.raw),
    paging,
    countRows[0].total,
  );
}

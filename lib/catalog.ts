// Reference lists (brands, cores, coverstocks): search, brand filter, sort and
// optional paging. Without page/size a plain array is returned, like the proxy.
import { query } from './db.js';
import { escapeLike, pageOf, SqlParams } from './params.js';
import { BrandQuery, CoreQuery, CoverstockQuery, DEFAULT_PAGE_SIZE, parseQuery, type RawQuery, sortOrders } from './schemas.js';

interface CatalogConfig {
  schema: typeof BrandQuery | typeof CoreQuery | typeof CoverstockQuery;
  searchExpr: string;
  sortSql: Record<string, string>;
  defaultOrder: string;
}

export const CATALOGS = {
  brands: {
    schema: BrandQuery,
    searchExpr: 'lower(name)',
    sortSql: { brand_name: 'lower(name)' },
    defaultOrder: 'lower(name)',
  },
  cores: {
    schema: CoreQuery,
    searchExpr: `lower(name) || ' ' || lower(coalesce(brand, ''))`,
    sortSql: { core_name: 'lower(name)', brand: 'lower(brand)' },
    defaultOrder: 'lower(brand), lower(name)',
  },
  coverstocks: {
    schema: CoverstockQuery,
    searchExpr: `lower(name) || ' ' || lower(coalesce(brand, ''))`,
    sortSql: { coverstock_name: 'lower(name)', brand: 'lower(brand)' },
    defaultOrder: 'lower(brand), lower(name)',
  },
} satisfies Record<string, CatalogConfig>;

export type CatalogTable = keyof typeof CATALOGS;

export async function findCatalog(table: CatalogTable, raw: RawQuery) {
  const config: CatalogConfig = CATALOGS[table];
  const q = parseQuery(config.schema, raw);
  const brands = 'brand' in q && Array.isArray(q.brand) ? q.brand : [];
  const paging = q.page !== undefined || q.size !== undefined ? { page: q.page ?? 0, size: q.size ?? DEFAULT_PAGE_SIZE } : null;

  const p = new SqlParams();
  const where = ['removed_at IS NULL'];
  if (q.search) where.push(`${config.searchExpr} LIKE ${p.add(`%${escapeLike(q.search.toLowerCase())}%`)}`);
  if (brands.length > 0) where.push(`lower(brand) = ANY(${p.add(brands.map((b) => b.toLowerCase()))}::text[])`);

  const sort = sortOrders(q.sort);
  const orderBy =
    (sort.length > 0 ? sort.map((s) => `${config.sortSql[s.field]} ${s.direction.toUpperCase()} NULLS LAST`).join(', ') : config.defaultOrder) + ', id';
  const whereSql = where.join(' AND ');

  if (!paging) {
    const { rows } = await query<{ raw: unknown }>(`SELECT raw FROM ${table} WHERE ${whereSql} ORDER BY ${orderBy}`, p.values);
    return rows.map((r) => r.raw);
  }

  const n = p.values.length;
  const [{ rows: countRows }, { rows }] = await Promise.all([
    query<{ total: number }>(`SELECT count(*)::int AS total FROM ${table} WHERE ${whereSql}`, p.values),
    query<{ raw: unknown }>(`SELECT raw FROM ${table} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT $${n + 1} OFFSET $${n + 2}`, [
      ...p.values,
      paging.size,
      paging.page * paging.size,
    ]),
  ]);
  return pageOf(
    rows.map((r) => r.raw),
    paging,
    countRows[0]?.total ?? 0,
  );
}

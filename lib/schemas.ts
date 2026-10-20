// Single source of truth for the API contract. Every request is validated
// with these schemas, the TypeScript types are inferred from them, and the
// OpenAPI document (lib/openapi.ts) is generated from them. Schemas with an
// `id` become reusable components in the OpenAPI document.

import { z } from 'zod';

// --------------------------------------------------------------- query parts

export const MARKETS = ['US', 'Overseas'] as const;
export const CORE_TYPES = ['Symmetric', 'Asymmetric'] as const;

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

const MAX_TEXT = 200;
const MAX_LIST_ITEMS = 100;

const text = (description: string) => z.string().max(MAX_TEXT).optional().meta({ description });

const list = (description: string) =>
  z
    .array(z.string().max(MAX_TEXT))
    .max(MAX_LIST_ITEMS)
    .default([])
    .meta({ description: `${description} Repeat the parameter for several values.` });

const number = (description: string, range: { min?: number; max?: number } = {}) => {
  let schema = z.coerce.number();
  if (range.min !== undefined) schema = schema.min(range.min);
  if (range.max !== undefined) schema = schema.max(range.max);
  return schema.optional().meta({ description });
};

const date = (description: string) =>
  z.iso
    .date()
    .optional()
    .meta({ description: `${description} (YYYY-MM-DD)` });

const boolean = (description: string) =>
  z
    .enum(['true', 'false', '1', '0'])
    .transform((value) => value === 'true' || value === '1')
    .optional()
    .meta({ description });

const weight = number('Ball weight in lbs.', { min: 0, max: 20 });

/** Spring-style sort: `field` or `field,asc|desc`, repeatable for tie-breakers. */
export function sortParam<const F extends readonly string[]>(fields: F) {
  const pattern = new RegExp(`^(${fields.join('|')})(,(asc|desc|ASC|DESC))?$`);
  return z
    .array(z.string().regex(pattern, { error: `must be "field" or "field,asc|desc" with field one of: ${fields.join(', ')}` }))
    .max(10)
    .default([])
    .meta({ description: `Sort order as \`field\` or \`field,asc|desc\`. Repeat for tie-breakers. Fields: ${fields.join(', ')}.` });
}

export const pagingParams = {
  page: z.coerce.number().int().min(0).max(100_000).default(0).meta({ description: 'Zero-based page number.' }),
  size: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .meta({ description: `Page size (max ${MAX_PAGE_SIZE}).` }),
};

// ---------------------------------------------------------------- ball query

export const BALL_SORT_FIELDS = [
  'ball_name',
  'brand_name',
  'release_date',
  'first_seen_at',
  'core_rg',
  'core_diff',
  'core_int_diff',
  'core_type',
  'coverstock_type',
  'factory_finish',
  'weight',
] as const;

export type BallSortField = (typeof BALL_SORT_FIELDS)[number];

export const BallQuery = z
  .object({
    search: text(
      'Fuzzy search over ball, brand, core and coverstock name and factory finish. Tolerates typos; separate several terms with commas. Without `sort`, results are ordered by relevance. Alias: `q`.',
    ),
    weight,
    brand: list('Brand name (exact, case-insensitive).'),
    core: list('Core name (exact, case-insensitive).'),
    coverstock: list('Coverstock name (exact, case-insensitive).'),
    coverstockType: list('Coverstock type, e.g. "Solid Reactive" (exact, case-insensitive).'),
    factoryFinish: list('Factory finish (exact, case-insensitive).'),
    id: list('Only these ball ids.'),
    excludeId: list('Leave out these ball ids.'),
    market: z.enum(MARKETS).optional().meta({ description: 'Market (case-insensitive).' }),
    coreType: z.enum(CORE_TYPES).optional().meta({ description: 'Core type (case-insensitive).' }),
    available: boolean('`true`: only available balls, `false`: only discontinued ones.'),
    releaseDate: text('Exact release date as the API returns it.'),
    releasedAfter: date('Released on or after this date'),
    releasedBefore: date('Released on or before this date'),
    addedAfter: date('First appeared in the catalog on or after this date'),
    minRg: number('Minimum core RG.'),
    maxRg: number('Maximum core RG.'),
    minDiff: number('Minimum core differential.'),
    maxDiff: number('Maximum core differential.'),
    minIntDiff: number('Minimum intermediate differential.'),
    maxIntDiff: number('Maximum intermediate differential.'),
    sort: sortParam(BALL_SORT_FIELDS),
    ...pagingParams,
  })
  .superRefine((q, ctx) => {
    const ranges = [
      ['minRg', 'maxRg'],
      ['minDiff', 'maxDiff'],
      ['minIntDiff', 'maxIntDiff'],
      ['releasedAfter', 'releasedBefore'],
    ] as const;
    for (const [min, max] of ranges) {
      const low = q[min];
      const high = q[max];
      if (low !== undefined && high !== undefined && low > high) {
        ctx.addIssue({ code: 'custom', path: [min], message: `must not be greater than "${max}"` });
      }
    }
  });

export type BallQuery = z.output<typeof BallQuery>;

export const WeightQuery = z.object({ weight });

/** Path parameter `{id}` (Vercel passes it in the query object). */
export const BallIdPath = z.object({ id: z.string().min(1).max(50).meta({ description: 'bowwwl ball id.' }) });

export const SimilarQuery = z.object({
  weight,
  limit: z.coerce.number().int().min(1).max(50).default(10).meta({ description: 'Maximum number of results.' }),
});

// ------------------------------------------------------------- catalog query

const catalogQuery = <const F extends readonly string[]>(sortFields: F, withBrand: boolean) =>
  z.object({
    search: text('Case-insensitive substring match on the name (and brand). Alias: `q`.'),
    ...(withBrand ? { brand: list('Brand (exact, case-insensitive).') } : {}),
    sort: sortParam(sortFields),
    // No defaults: whether page/size were given decides between array and page.
    page: z.coerce
      .number()
      .int()
      .min(0)
      .max(100_000)
      .optional()
      .meta({ description: 'Zero-based page number. When `page` or `size` is given, the response is a page instead of an array.' }),
    size: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .optional()
      .meta({
        description: `Page size (max ${MAX_PAGE_SIZE}, default ${DEFAULT_PAGE_SIZE}). When \`page\` or \`size\` is given, the response is a page instead of an array.`,
      }),
  });

export const BrandQuery = catalogQuery(['brand_name'] as const, false);
export const CoreQuery = catalogQuery(['core_name', 'brand'] as const, true);
export const CoverstockQuery = catalogQuery(['coverstock_name', 'brand'] as const, true);

export type CatalogQuery = z.output<typeof CoreQuery>;

// ------------------------------------------------------------------ responses

// Upstream (bowwwl.com) sends every value as a string; the API passes the
// objects through unchanged, so these mirror that shape. Unknown extra fields
// are kept (loose objects).
const upstreamText = z.string().nullable();

export const Ball = z
  .looseObject({
    ball_id: z.string(),
    ball_name: z.string(),
    core_weight: z.string().meta({ description: 'Weight in lbs, e.g. "15". A ball exists once per weight.' }),
    availability: upstreamText.meta({ description: '"Available" or a discontinued state.' }),
    ball_image: upstreamText,
    brand_id: upstreamText,
    brand_name: upstreamText,
    core_diff: upstreamText,
    core_id: upstreamText,
    core_image: upstreamText,
    core_int_diff: upstreamText,
    core_name: upstreamText,
    core_rg: upstreamText,
    core_type: upstreamText,
    coverstock_id: upstreamText,
    coverstock_name: upstreamText,
    coverstock_type: upstreamText,
    factory_finish: upstreamText,
    last_update: upstreamText,
    release_date: upstreamText,
    thumbnail_image: upstreamText,
    us_int: upstreamText.meta({ description: '"US" or "Overseas".' }),
    first_seen_at: z.string().meta({ description: 'When this ball first appeared in the catalog (ISO timestamp).' }),
    removed_at: z.string().nullable().optional().meta({ description: 'Only on `GET /balls/{id}`: when the ball disappeared upstream, or null.' }),
  })
  .meta({ id: 'Ball', description: 'A ball in one weight, as bowwwl.com describes it, plus catalog metadata.' });

export type Ball = z.infer<typeof Ball>;

export const PageMeta = z
  .object({
    number: z.number().int(),
    size: z.number().int(),
    totalElements: z.number().int(),
    totalPages: z.number().int(),
  })
  .meta({ id: 'PageMeta' });

export const BallPage = z
  .object({ content: z.array(Ball), page: PageMeta })
  .meta({ id: 'BallPage', description: 'One page of balls (Spring `PagedModel` shape).' });

export type BallPage = z.infer<typeof BallPage>;

export const Brand = z.looseObject({ id: z.string(), brand_name: z.string(), logo: upstreamText.optional() }).meta({ id: 'Brand' });
export const Core = z
  .looseObject({ id: z.string(), core_name: z.string(), brand: upstreamText, api_filter_url: upstreamText.optional() })
  .meta({ id: 'Core' });
export const Coverstock = z
  .looseObject({ id: z.string(), coverstock_name: z.string(), brand: upstreamText, api_filter_url: upstreamText.optional() })
  .meta({ id: 'Coverstock' });

export type Brand = z.infer<typeof Brand>;
export type Core = z.infer<typeof Core>;
export type Coverstock = z.infer<typeof Coverstock>;

const pageOf = <T extends z.ZodType>(item: T, id: string) => z.object({ content: z.array(item), page: PageMeta }).meta({ id });

export const BrandPage = pageOf(Brand, 'BrandPage');
export const CorePage = pageOf(Core, 'CorePage');
export const CoverstockPage = pageOf(Coverstock, 'CoverstockPage');

export const SyncRun = z
  .object({
    id: z.string().meta({ description: 'Run id (bigint as string).' }),
    started_at: z.string(),
    finished_at: z.string().nullable(),
    status: z.enum(['running', 'success', 'partial', 'failed']),
    trigger: z.string(),
    stats: z.record(z.string(), z.unknown()).meta({ description: 'Per part (table or weight): fetched, inserted, updated, removed, source.' }),
    errors: z.array(z.string()),
  })
  .meta({ id: 'SyncRun' });

export type SyncRun = z.infer<typeof SyncRun>;

export const SyncSkipped = z.object({ skipped: z.literal(true) }).meta({ id: 'SyncSkipped', description: 'Another sync was still running.' });

export const Health = z
  .object({
    status: z.enum(['ok', 'empty']).meta({ description: '`empty`: tables exist but no sync has run yet.' }),
    counts: z.object({
      balls: z.number().int(),
      brands: z.number().int(),
      cores: z.number().int(),
      coverstocks: z.number().int(),
    }),
    lastSync: SyncRun.nullable(),
  })
  .meta({ id: 'Health' });

export type Health = z.infer<typeof Health>;

export const NotInitialized = z
  .object({ status: z.literal('not_initialized'), hint: z.string() })
  .meta({ id: 'NotInitialized', description: 'The database has no tables yet; run the sync once.' });

export const ApiError = z.object({ error: z.string() }).meta({ id: 'Error' });

// ------------------------------------------------------------ query parsing

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

export type RawQuery = Record<string, string | string[] | undefined>;

type AnySchema = z.ZodType;

/** Unwraps optional/default/pipe wrappers to the schema that decides the shape. */
function baseOf(schema: AnySchema): AnySchema {
  const def = (schema as unknown as { def: { type: string; innerType?: AnySchema; in?: AnySchema } }).def;
  if ((def.type === 'optional' || def.type === 'default' || def.type === 'nullable') && def.innerType) return baseOf(def.innerType);
  if (def.type === 'pipe' && def.in) return baseOf(def.in);
  return schema;
}

/**
 * Turns a raw query string object into what the schema expects:
 * - list parameters always become arrays (`?brand=a` and `?brand=a&brand=b`),
 *   blank entries dropped;
 * - single parameters take the last value if repeated; blank means absent;
 * - enum values are matched case-insensitively to their canonical spelling;
 * - `q` is an alias for `search`;
 * - unknown parameters are ignored.
 */
export function normalizeQuery(schema: z.ZodObject, raw: RawQuery): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, fieldSchema] of Object.entries(schema.shape)) {
    const value = key === 'search' ? (raw.search ?? raw.q) : raw[key];
    if (value === undefined) continue;
    const base = baseOf(fieldSchema as AnySchema);

    if (base instanceof z.ZodArray) {
      const values = (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter(Boolean);
      if (values.length > 0) result[key] = values;
      continue;
    }

    const single = (Array.isArray(value) ? value[value.length - 1] : value)?.trim();
    if (!single) continue;

    if (base instanceof z.ZodEnum) {
      const options = base.options as string[];
      result[key] = options.find((option) => option.toLowerCase() === single.toLowerCase()) ?? single;
    } else {
      result[key] = single;
    }
  }
  return result;
}

/** Validates a query string; any problem becomes a 400 with a readable message. */
export function parseQuery<S extends z.ZodObject>(schema: S, raw: RawQuery): z.output<S> {
  const result = schema.safeParse(normalizeQuery(schema, raw));
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const name = String(issue.path[0] ?? 'query');
    throw new BadRequestError(`Parameter "${name}" ${issue.message.charAt(0).toLowerCase()}${issue.message.slice(1)}`);
  }
  return result.data;
}

/** Turns `field,dir` entries into structured sort orders. */
export function sortOrders<F extends string>(entries: string[]): { field: F; direction: 'asc' | 'desc' }[] {
  return entries.map((entry) => {
    const [field, direction = 'asc'] = entry.split(',');
    return { field: field as F, direction: direction.toLowerCase() as 'asc' | 'desc' };
  });
}

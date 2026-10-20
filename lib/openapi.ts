// Builds the OpenAPI 3.1 document from the Zod schemas in schemas.ts, so the
// docs can't drift from what the handlers validate and return.
import { z } from 'zod';
import {
  ApiError,
  Ball,
  BallIdPath,
  BallPage,
  BallQuery,
  Brand,
  BrandPage,
  BrandQuery,
  Core,
  CorePage,
  CoreQuery,
  Coverstock,
  CoverstockPage,
  CoverstockQuery,
  Health,
  NotInitialized,
  PageMeta,
  SimilarQuery,
  SyncRun,
  SyncSkipped,
  WeightQuery,
} from './schemas.js';

type JsonSchema = Record<string, unknown>;

const COMPONENTS = [
  Ball,
  BallPage,
  PageMeta,
  Brand,
  BrandPage,
  Core,
  CorePage,
  Coverstock,
  CoverstockPage,
  Health,
  NotInitialized,
  SyncRun,
  SyncSkipped,
  ApiError,
];

const ref = (schema: z.ZodType): JsonSchema => {
  const id = z.globalRegistry.get(schema)?.id;
  if (!id) throw new Error('Schema has no id');
  return { $ref: `#/components/schemas/${id}` };
};

const json = (schema: JsonSchema, description: string) => ({ description, content: { 'application/json': { schema } } });

const errors = {
  '400': json(ref(ApiError), 'Invalid parameter.'),
  '429': json(ref(ApiError), 'Rate limit exceeded (100 requests per minute per IP).'),
  '500': json(ref(ApiError), 'Server error.'),
};

/** Turns a query (or path) object schema into OpenAPI parameter objects. */
function parameters(schema: z.ZodObject, location: 'query' | 'path' = 'query') {
  return Object.entries(schema.shape).map(([name, field]) => {
    const { $schema: _, description, ...fieldSchema } = z.toJSONSchema(field as z.ZodType, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
    const isArray = fieldSchema.type === 'array';
    return {
      name,
      in: location,
      required: location === 'path',
      ...(description ? { description } : {}),
      schema: fieldSchema,
      ...(isArray ? { style: 'form', explode: true } : {}),
    };
  });
}

const get = (operationId: string, summary: string, operation: Record<string, unknown>) => ({
  // Public unless the operation says otherwise.
  get: { operationId, summary, security: [], ...operation },
});

const catalogOperation = (tag: string, query: z.ZodObject, item: z.ZodType, page: z.ZodType) => ({
  tags: [tag],
  parameters: parameters(query),
  responses: {
    '200': json(
      { oneOf: [{ type: 'array', items: ref(item) }, ref(page)] },
      'A plain array, or a page when `page` or `size` is given. Sorted by name (and brand).',
    ),
    ...errors,
  },
});

export function buildOpenApi(): JsonSchema {
  const { schemas } = z.toJSONSchema(z.globalRegistry, { uri: (id) => `#/components/schemas/${id}` }) as { schemas: Record<string, JsonSchema> };
  const components: Record<string, JsonSchema> = {};
  for (const schema of COMPONENTS) {
    const id = z.globalRegistry.get(schema)!.id!;
    const { $schema: _, $id: __, ...rest } = schemas[id]!;
    components[id] = rest;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Lightning Bowl Ball API',
      version: '1.0.0',
      license: { name: 'ISC', identifier: 'ISC' },
      description:
        'Ball catalog for Lightning Bowl, mirrored nightly from bowwwl.com into Postgres. Search, filtering, sorting and paging run in the database.\n\n' +
        'Conventions: `page` is zero-based; `sort` is `field` or `field,asc|desc` and repeatable; list parameters repeat (`brand=Storm&brand=Hammer`). ' +
        'Errors are `{ "error": "..." }`.',
    },
    servers: [{ url: '/api' }],
    tags: [
      { name: 'Balls', description: 'The ball catalog, one entry per ball and weight.' },
      { name: 'Catalog', description: 'Brands, cores and coverstocks.' },
      { name: 'Operations', description: 'Health and the nightly sync.' },
    ],
    paths: {
      '/balls': get('searchBalls', 'Search, filter, sort and page balls', {
        tags: ['Balls'],
        description: 'Default order: newest release first. With `search` and no `sort`: best match first. An explicit `sort` orders all matches.',
        parameters: parameters(BallQuery),
        responses: { '200': json(ref(BallPage), 'One page of balls.'), ...errors },
      }),
      '/balls/export': get('exportBalls', 'Whole catalog as an array', {
        tags: ['Balls'],
        description: 'Every active ball (optionally one weight), newest first. Not paged.',
        parameters: parameters(WeightQuery),
        responses: { '200': json({ type: 'array', items: ref(Ball) }, 'All balls.'), ...errors },
      }),
      '/balls/{id}': get('getBall', 'One ball in all its weights', {
        tags: ['Balls'],
        description: 'Heaviest first. Includes balls removed upstream (with `removed_at` set).',
        parameters: [...parameters(BallIdPath, 'path'), ...parameters(WeightQuery)],
        responses: {
          '200': json({ type: 'array', items: ref(Ball) }, 'Weight variants.'),
          '404': json(ref(ApiError), 'Unknown ball.'),
          ...errors,
        },
      }),
      '/balls/{id}/similar': get('getSimilarBalls', 'Balls with a similar reaction', {
        tags: ['Balls'],
        description:
          'Same weight, core type and coverstock type; RG within 0.03, differential within 0.008, and for asymmetric cores intermediate differential within 0.005. Newest first.',
        parameters: [...parameters(BallIdPath, 'path'), ...parameters(SimilarQuery)],
        responses: {
          '200': json({ type: 'array', items: ref(Ball) }, 'Similar balls (empty if the ball has no specs).'),
          '404': json(ref(ApiError), 'Unknown ball.'),
          ...errors,
        },
      }),
      '/brands': get('listBrands', 'Brands', catalogOperation('Catalog', BrandQuery, Brand, BrandPage)),
      '/cores': get('listCores', 'Cores', catalogOperation('Catalog', CoreQuery, Core, CorePage)),
      '/coverstocks': get('listCoverstocks', 'Coverstocks', catalogOperation('Catalog', CoverstockQuery, Coverstock, CoverstockPage)),
      '/health': get('getHealth', 'Catalog size and last sync', {
        tags: ['Operations'],
        responses: {
          '200': json(ref(Health), 'Status.'),
          '429': errors['429'],
          '503': json(ref(NotInitialized), 'Database not set up yet.'),
          '500': errors['500'],
        },
      }),
      '/cron/sync': get('runSync', 'Run the catalog sync', {
        tags: ['Operations'],
        description: 'Called nightly by Vercel Cron. Applies pending migrations, then imports from bowwwl.com.',
        security: [{ cronSecret: [] }],
        responses: {
          '200': json(ref(SyncRun), 'Finished run (`success` or `partial`).'),
          '401': json(ref(ApiError), 'Missing or wrong secret.'),
          '409': json(ref(SyncSkipped), 'Another run is in progress.'),
          '502': json(ref(SyncRun), 'Every part of the run failed.'),
          '500': errors['500'],
        },
      }),
    },
    components: {
      schemas: components,
      securitySchemes: {
        cronSecret: { type: 'http', scheme: 'bearer', description: '`CRON_SECRET`' },
      },
    },
  };
}

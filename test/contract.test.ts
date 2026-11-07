// Every endpoint's real response must match the schema the docs publish, and
// the committed openapi.json must match what the schemas generate.
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import ballHandler from '../api/balls/[id]/index.js';
import similarHandler from '../api/balls/[id]/similar.js';
import exportHandler from '../api/balls/export.js';
import ballsHandler from '../api/balls/index.js';
import brandsHandler from '../api/brands.js';
import coresHandler from '../api/cores.js';
import coverstocksHandler from '../api/coverstocks.js';
import cronHandler from '../api/cron/sync.js';
import docsHandler from '../api/docs.js';
import healthHandler from '../api/health.js';
import openapiHandler from '../api/openapi.js';
import type { Handler } from '../lib/http.js';
import {
  ApiError,
  Ball,
  BallPage,
  Brand,
  BrandPage,
  Core,
  CorePage,
  Coverstock,
  CoverstockPage,
  Health,
  type RawQuery,
  SyncRun,
} from '../lib/schemas.js';
import { runSync } from '../lib/sync.js';
import { serializeOpenApi } from '../scripts/openapi.js';
import { startDatabase } from './helpers/db.js';
import { fakeUpstream } from './helpers/fixtures.js';
import { call } from './helpers/http.js';

let stop: () => Promise<void>;
before(async () => {
  stop = await startDatabase();
  await runSync({ weights: [14, 15], fetchFn: fakeUpstream().fetchFn, log: () => {} });
});
after(() => stop());

async function expectShape(handler: Handler, query: RawQuery, schema: z.ZodType, status = 200, headers: Record<string, string> = {}) {
  const res = await call(handler, query, { headers });
  assert.equal(res.statusCode, status, JSON.stringify(res.body));
  const result = schema.safeParse(res.body);
  assert.ok(result.success, result.success ? '' : z.prettifyError(result.error));
}

test('balls endpoints match their documented schemas', async () => {
  await expectShape(ballsHandler, {}, BallPage);
  await expectShape(ballsHandler, { search: 'phaze', size: '1' }, BallPage);
  process.env.ADMIN_SECRET = 'contract-admin';
  await expectShape(exportHandler, {}, z.array(Ball), 200, { authorization: 'Bearer contract-admin' });
  await expectShape(ballHandler, { id: '1' }, z.array(Ball));
  await expectShape(similarHandler, { id: '1' }, z.array(Ball));
});

test('catalog endpoints match their schemas, as arrays and as pages', async () => {
  await expectShape(brandsHandler, {}, z.array(Brand));
  await expectShape(brandsHandler, { size: '2' }, BrandPage);
  await expectShape(coresHandler, {}, z.array(Core));
  await expectShape(coresHandler, { page: '0' }, CorePage);
  await expectShape(coverstocksHandler, {}, z.array(Coverstock));
  await expectShape(coverstocksHandler, { size: '1' }, CoverstockPage);
});

test('health, errors and the sync match their schemas', async () => {
  process.env.ADMIN_SECRET = 'contract-admin';
  await expectShape(healthHandler, {}, Health, 200, { authorization: 'Bearer contract-admin' });
  await expectShape(healthHandler, {}, ApiError, 401);
  await expectShape(ballsHandler, { sort: 'nope' }, ApiError, 400);
  await expectShape(ballHandler, { id: 'missing' }, ApiError, 404);

  process.env.CRON_SECRET = 'contract-secret';
  await expectShape(cronHandler, {}, ApiError, 401);
});

test('a sync run matches the SyncRun schema', async () => {
  const run = await runSync({ weights: [15], fetchFn: fakeUpstream().fetchFn, log: () => {} });
  const result = SyncRun.safeParse(JSON.parse(JSON.stringify(run)));
  assert.ok(result.success, result.success ? '' : z.prettifyError(result.error));
});

test('the committed openapi.json is up to date (run `npm run openapi`)', () => {
  assert.equal(readFileSync('openapi.json', 'utf8'), serializeOpenApi());
});

test('openapi and docs endpoints serve the spec and Swagger UI', async () => {
  const spec = await call(openapiHandler);
  assert.equal(spec.statusCode, 200);
  assert.equal(spec.body.openapi, '3.1.0');
  assert.equal(spec.headers['access-control-allow-origin'], '*');

  const docs = await call(docsHandler);
  assert.match(docs.headers['content-type'] ?? '', /text\/html/);
  assert.match(docs.text ?? '', /SwaggerUIBundle\(\{ url: '\/api\/openapi.json'/);
});

test('query validation: readable errors, case-insensitive enums, repeated params', async () => {
  const bad = await call(ballsHandler, { size: '500' });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.error, /^Parameter "size"/);

  const sort = await call(ballsHandler, { sort: 'raw' });
  assert.match(sort.body.error, /^Parameter "sort" must be "field" or "field,asc\|desc"/);

  const range = await call(ballsHandler, { minRg: '3', maxRg: '2' });
  assert.match(range.body.error, /^Parameter "minRg" must not be greater than "maxRg"/);

  assert.equal((await call(ballsHandler, { market: 'overseas' })).statusCode, 200);
  assert.equal((await call(ballsHandler, { brand: ['storm', 'hammer'], available: '1' })).statusCode, 200);
  assert.equal((await call(ballsHandler, { size: ['5', '2'] })).body.page.size, 2, 'last value wins for single params');
  assert.equal((await call(ballsHandler, { q: 'phaze' })).body.page.totalElements, 3, 'q is an alias for search (Phaze II 14 + 15 lb, Phaze V)');
});

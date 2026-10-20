# Lightning Bowl Ball API

Ball catalog API for [Lightning Bowl](https://github.com/HappyKnuckles/lightningbowl). The bowwwl.com catalog is mirrored into Postgres (Neon) every night. Search, filtering, sorting and paging all run in the database with indexes.

- **Runtime:** TypeScript (strict) on Node 20+ serverless functions on Vercel
- **Contract:** Zod schemas in `lib/schemas.ts` validate every request and generate the TypeScript types and the OpenAPI document
- **Database:** Postgres 16+ with `pg_trgm` (Neon)
- **Sync:** Vercel Cron, daily at 01:17 UTC (03:17 Berlin in summer, 02:17 in winter)

## Setup

1. **Deploy to Vercel** and connect a Neon database (Storage → Neon). The integration sets `DATABASE_URL` / `POSTGRES_URL`.
2. **Add `CRON_SECRET`** (any long random string, e.g. `openssl rand -hex 32`) and **`ALLOWED_ORIGINS`** (the app's production origin), then redeploy so the function picks them up.
3. **Run the first sync:** Vercel → project → **Settings → Cron Jobs** → **Run** next to `/api/cron/sync`. It creates the tables and imports the catalog; takes a minute or two. After that it runs nightly on its own.
4. **Check** `GET /api/health`: `counts.balls` should be in the thousands and `lastSync.status` `success` (or `partial`, see below).

Local development: copy `.env.example` to `.env.local`, then `npm install`, `npm run sync` (also migrates) and `npm run dev` (http://localhost:3003, docs at `/api/docs`). `npm test` runs against a throwaway embedded Postgres and needs no database; `npm run typecheck` runs `tsc`.

## How the sync works

`lib/sync.js` first applies any pending migrations, then fetches brands, cores, coverstocks and the balls for each weight (`SYNC_WEIGHTS`, default 12–16 lb).

- **Ball source:** the paged v2 endpoint (`/restapi/balls/v2`), because bowwwl's full-catalog endpoint (`/restapi/balls?_format=json`) is broken. v2 is read once per run and split by weight. A weight v2 doesn't contain falls back to the legacy per-weight endpoint; if that fails too, that weight is reported as an error, its existing rows are left alone and the run ends as `partial`. `stats.balls_<weight>.source` shows which source was used.

- **New balls** are inserted and keep their `first_seen_at`, which the API exposes and which `addedAfter` / `sort=first_seen_at` use.
- **Changed balls** are updated. Unchanged rows aren't written at all.
- **Balls that vanish upstream** are soft-deleted (`removed_at`) and restored automatically if they come back. Removal is skipped when a response has less than half the expected rows, so a broken upstream response can't empty the catalog.
- **Failures are isolated.** Each part (a table or a weight) succeeds or fails on its own, and the run ends as `success`, `partial` or `failed`.
- **Runs are logged** in `sync_runs`. Overlapping runs are skipped, and runs that never finished are closed out after 30 minutes. `GET /api/health` shows the latest run.

Every row keeps the untouched upstream object in `raw`, and the API returns that object, so clients get exactly the shape they know from bowwwl.com. The typed columns next to it are what queries run on.

## Docs and types

- **Swagger UI:** `GET /api/docs`
- **OpenAPI 3.1 document:** `GET /api/openapi.json` (readable from any origin), also committed as [`openapi.json`](openapi.json)

Everything comes from `lib/schemas.ts`: the handlers validate requests with those schemas, the TypeScript types are inferred from them, and `lib/openapi.ts` generates the document. A contract test checks every endpoint's real response against its documented schema, and another fails if the committed `openapi.json` is stale. Run `npm run openapi` after changing a schema.

Clients can generate types from the document, for example the Angular app:

```bash
npx openapi-typescript https://balls.lightningbowl.de/api/openapi.json -o src/app/core/models/ball-api.d.ts
```

```ts
import type { components } from './ball-api';
type Ball = components['schemas']['Ball'];
type BallPage = components['schemas']['BallPage'];
```

## API

Conventions:

- **Paging** (Spring-style): `page` is zero-based (default `0`); `size` defaults to `20`, max `100`.
- **Sorting** (Spring-style): `sort=field` or `sort=field,asc|desc`. Repeat it for tie-breakers. NULLs always sort last.
- **Multi-value filters:** repeat the parameter (`brand=Storm&brand=Hammer`). Text matching is case-insensitive.
- **Errors:** `400` invalid parameter, `404` not found, `429` rate limited, `500` server error. The body is always `{ "error": "..." }`.

Paged response:

```json
{
  "content": [{ "ball_id": "…", "ball_name": "…", "first_seen_at": "…" }],
  "page": { "number": 0, "size": 20, "totalElements": 1234, "totalPages": 62 }
}
```

### `GET /api/balls`

| Parameter | Description |
| --- | --- |
| `search` (alias `q`) | Fuzzy search over ball, brand, core and coverstock name and factory finish. Tolerates typos; separate several terms with commas. Without `sort`, results are ordered by relevance. |
| `weight` | Ball weight in lbs. |
| `brand`, `core`, `coverstock`, `coverstockType`, `factoryFinish` | Exact match, case-insensitive, repeatable. |
| `market` | `US` or `Overseas`. |
| `coreType` | `Symmetric` or `Asymmetric`. |
| `available` | `true` = available only, `false` = discontinued only. |
| `releaseDate` | Exact release date as the API returns it. |
| `releasedAfter`, `releasedBefore` | Release date range, `YYYY-MM-DD`, inclusive. |
| `addedAfter` | Balls that first appeared in the catalog on or after this date (`YYYY-MM-DD`). |
| `minRg`, `maxRg`, `minDiff`, `maxDiff`, `minIntDiff`, `maxIntDiff` | Core spec ranges, inclusive. |
| `id` / `excludeId` | Include only / leave out these ball IDs, repeatable. |
| `sort` | `ball_name`, `brand_name`, `release_date`, `first_seen_at`, `core_rg`, `core_diff`, `core_int_diff`, `core_type`, `coverstock_type`, `factory_finish`, `weight`. |
| `page`, `size` | Paging. |

The default order is newest release first.

```
/api/balls?weight=15&brand=Storm&coreType=Asymmetric&sort=core_diff,desc
/api/balls?search=phaze,widow&available=true
/api/balls?core=Velocity&excludeId=1234&weight=15     # same core
/api/balls?addedAfter=2026-10-01&sort=first_seen_at,desc   # new in the catalog
```

### `GET /api/balls/export[?weight=15]`

The whole active catalog (optionally one weight) as a plain array, newest first. Not paged. Meant for clients that keep an offline copy. CDN-cached for an hour.

### `GET /api/balls/{id}[?weight=15]`

All weight variants of a ball, heaviest first. This includes balls removed upstream (with `removed_at` set), so arsenal entries keep resolving. Returns `404` if the ball is unknown.

### `GET /api/balls/{id}/similar[?weight=15][&limit=10]`

Balls of the same weight with a similar expected reaction: same core type and coverstock type, RG within 0.03, differential within 0.008, and, for asymmetric cores, intermediate differential within 0.005. Newest first; `limit` is 1–50.

### `GET /api/brands`, `/api/cores`, `/api/coverstocks`

Sorted by name (cores and coverstocks by brand, then name). Optional parameters:

- `search`: substring match
- `brand`: repeatable; cores and coverstocks only
- `sort`: `brand_name` for brands; `core_name` / `coverstock_name` and `brand` for the others
- `page` / `size`: a plain array is returned unless one of these is given

### `GET /api/health`

Catalog counts and the latest sync run. Not cached.

## Indexes

| Query | Index |
| --- | --- |
| Default listing | `release_date DESC, lower(ball_name)` |
| Text filters and sorts | `lower(brand_name)`, `lower(core_name)`, `lower(coverstock_name)`, `lower(coverstock_type)`, `lower(factory_finish)`, `lower(ball_name)` |
| Exact filters | `core_type`, `weight` |
| Spec ranges and sorts | `core_rg`, `core_diff`, `core_int_diff` |
| Similar balls | `(weight, core_type, coverstock_type, core_rg, core_diff)` |
| Fuzzy search | GIN `pg_trgm` on a generated `search_text` column (`word_similarity` and `LIKE '%…%'`) |
| Catalog search | GIN `pg_trgm` on brand, core and coverstock names |

The search transaction sets `enable_seqscan = off` locally. On a 10k-row table, Postgres otherwise picks a seq scan (~70 ms) over the trigram index (~4 ms).

## Ball statistics (data model only)

`migrations/002_ball_stats.sql` prepares community stats. No endpoint reads or writes them yet.

- **`stat_contributors`:** one row per app install, keyed by a hash of a random install ID (no personal data).
- **`stat_arsenal`:** which balls an install has in its arsenal.
- **`stat_ball_games`:** per install and ball, the totals of games, score, high score, strikes and spares. Constraints reject impossible values (e.g. a score above 300 per game).
- **`ball_stats` view:** per ball, arsenal count, bowlers and games, plus average, high score and strikes/spares per game. The score figures stay `NULL` until at least 3 bowlers have used the ball.

The plan is for the app to send a snapshot of its own totals, which replaces that install's previous rows, so retries never double count.

## Environment variables

| Variable | |
| --- | --- |
| `DATABASE_URL` | Neon pooled connection string (required). `POSTGRES_URL` also works; Vercel's Neon integration sets both. |
| `CRON_SECRET` | Protects `/api/cron/sync` (required in production). |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins. Vercel previews of the app are always allowed. |
| `SYNC_WEIGHTS` | Weights to sync, default `12,13,14,15,16`. |
| `DB_POOL_MAX` | Connections per function instance, default `3`. |
| `BOWWWL_API_BASE` | Upstream base URL, default `https://bowwwl.com/restapi`. |

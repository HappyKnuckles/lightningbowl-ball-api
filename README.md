# Lightning Bowl Ball API

Ball catalog API for [Lightning Bowl](https://github.com/HappyKnuckles/lightningbowl). The bowwwl.com catalog is mirrored into Postgres (Neon) every night. Search, filtering, sorting and paging all run in the database with indexes.

- **Runtime:** Node 20+ serverless functions on Vercel
- **Database:** Postgres 16+ with `pg_trgm` (Neon)
- **Sync:** Vercel Cron, daily at 01:17 UTC (03:17 Berlin in summer, 02:17 in winter)

## Setup

1. **Create a Neon project.** Copy the **pooled** connection string (host contains `-pooler`).
2. **Create `.env.local`** from `.env.example` and fill in `DATABASE_URL` and `CRON_SECRET` (any long random string, e.g. `openssl rand -hex 32`).
3. **Install and load the catalog:**
   ```bash
   npm install
   npm run migrate   # create tables and indexes
   npm run sync      # first import from bowwwl.com
   npm run dev       # http://localhost:3003
   ```
4. **Deploy to Vercel:** import the repo and set `DATABASE_URL`, `CRON_SECRET` and `ALLOWED_ORIGINS` as environment variables. The cron job in `vercel.json` registers itself on the production deployment. Vercel sends `Authorization: Bearer $CRON_SECRET`, which `/api/cron/sync` checks.
5. **Migrations:** run `npm run migrate` against Neon whenever a new file appears in `migrations/`. Migrations are forward-only and each one is applied once.

`npm test` runs the suite against a throwaway embedded Postgres, so it needs no database setup.

## How the sync works

`lib/sync.js` fetches brands, cores, coverstocks and the balls for each weight (`SYNC_WEIGHTS`, default 12–16 lb).

- **New balls** are inserted and keep their `first_seen_at`, which the API exposes and which `addedAfter` / `sort=first_seen_at` use.
- **Changed balls** are updated. Unchanged rows aren't written at all.
- **Balls that vanish upstream** are soft-deleted (`removed_at`) and restored automatically if they come back. Removal is skipped when a response has less than half the expected rows, so a broken upstream response can't empty the catalog.
- **Failures are isolated.** Each part (a table or a weight) succeeds or fails on its own, and the run ends as `success`, `partial` or `failed`.
- **Runs are logged** in `sync_runs`. Overlapping runs are skipped, and runs that never finished are closed out after 30 minutes. `GET /api/health` shows the latest run.

Every row keeps the untouched upstream object in `raw`, and the API returns that object, so clients get exactly the shape they know from bowwwl.com. The typed columns next to it are what queries run on.

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
| `DATABASE_URL` | Neon pooled connection string (required). |
| `CRON_SECRET` | Protects `/api/cron/sync` (required in production). |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins. Vercel previews of the app are always allowed. |
| `SYNC_WEIGHTS` | Weights to sync, default `12,13,14,15,16`. |
| `DB_POOL_MAX` | Connections per function instance, default `3`. |
| `BOWWWL_API_BASE` | Upstream base URL, default `https://bowwwl.com/restapi`. |

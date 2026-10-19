-- Ball catalog mirrored from bowwwl.com.
--
-- Every table keeps the untouched upstream object in `raw` (that is what the
-- API returns, so clients see the same shape as before) plus typed columns
-- that filtering, sorting and search run on. Rows that disappear upstream are
-- soft-deleted via `removed_at` and come back automatically if they reappear.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE brands (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  raw           jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz
);
CREATE INDEX brands_name_lower_idx ON brands (lower(name));
CREATE INDEX brands_name_trgm_idx ON brands USING gin (lower(name) gin_trgm_ops);

CREATE TABLE cores (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  brand         text,
  raw           jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz
);
CREATE INDEX cores_brand_name_idx ON cores (lower(brand), lower(name));
CREATE INDEX cores_search_trgm_idx ON cores USING gin ((lower(name) || ' ' || lower(coalesce(brand, ''))) gin_trgm_ops);

CREATE TABLE coverstocks (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  brand         text,
  raw           jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz
);
CREATE INDEX coverstocks_brand_name_idx ON coverstocks (lower(brand), lower(name));
CREATE INDEX coverstocks_search_trgm_idx ON coverstocks USING gin ((lower(name) || ' ' || lower(coalesce(brand, ''))) gin_trgm_ops);

-- One row per ball and weight: the same ball exists in several weights with
-- different core specs.
CREATE TABLE balls (
  ball_id         text NOT NULL,
  core_weight     text NOT NULL,
  weight          numeric,
  ball_name       text NOT NULL,
  brand_id        text,
  brand_name      text,
  core_id         text,
  core_name       text,
  core_type       text,
  core_rg         numeric,
  core_diff       numeric,
  core_int_diff   numeric,
  coverstock_id   text,
  coverstock_name text,
  coverstock_type text,
  factory_finish  text,
  availability    text,
  us_int          text,
  release_date    date,
  raw             jsonb NOT NULL,
  search_text     text GENERATED ALWAYS AS (
    lower(
      coalesce(ball_name, '') || ' ' || coalesce(brand_name, '') || ' ' || coalesce(core_name, '') || ' ' ||
      coalesce(coverstock_name, '') || ' ' || coalesce(factory_finish, '')
    )
  ) STORED,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,
  PRIMARY KEY (ball_id, core_weight)
);

-- Default listing: newest first.
CREATE INDEX balls_release_date_idx ON balls (release_date DESC NULLS LAST, lower(ball_name));
-- Case-insensitive equality filters (and sorts on the same expressions).
CREATE INDEX balls_ball_name_idx ON balls (lower(ball_name));
CREATE INDEX balls_brand_name_idx ON balls (lower(brand_name));
CREATE INDEX balls_core_name_idx ON balls (lower(core_name));
CREATE INDEX balls_coverstock_name_idx ON balls (lower(coverstock_name));
CREATE INDEX balls_coverstock_type_idx ON balls (lower(coverstock_type));
CREATE INDEX balls_factory_finish_idx ON balls (lower(factory_finish));
CREATE INDEX balls_core_type_idx ON balls (core_type);
CREATE INDEX balls_weight_idx ON balls (weight);
-- Spec ranges and sorts.
CREATE INDEX balls_core_rg_idx ON balls (core_rg);
CREATE INDEX balls_core_diff_idx ON balls (core_diff);
CREATE INDEX balls_core_int_diff_idx ON balls (core_int_diff);
-- "Similar reaction" lookups.
CREATE INDEX balls_similar_idx ON balls (weight, core_type, coverstock_type, core_rg, core_diff);
-- Fuzzy search (word_similarity via <% and LIKE '%term%').
CREATE INDEX balls_search_trgm_idx ON balls USING gin (search_text gin_trgm_ops);

CREATE TABLE sync_runs (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
  trigger     text NOT NULL,
  stats       jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors      jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX sync_runs_started_at_idx ON sync_runs (started_at DESC);

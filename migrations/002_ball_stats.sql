-- Community ball statistics (data model only; no endpoints write or read it yet).
--
-- Game data lives on users' devices, so the app will report a snapshot of its
-- own totals per install. A new snapshot replaces that install's previous
-- rows, so retries and re-syncs never double count. Installs are identified
-- only by a hash of a random per-install ID.

CREATE TABLE stat_contributors (
  install_hash  text PRIMARY KEY,           -- sha256 of the app's random install ID
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stat_contributors_updated_at_idx ON stat_contributors (updated_at);

-- Which balls an install currently has in its arsenal.
CREATE TABLE stat_arsenal (
  install_hash text NOT NULL REFERENCES stat_contributors ON DELETE CASCADE,
  ball_id      text NOT NULL,
  PRIMARY KEY (install_hash, ball_id)
);
CREATE INDEX stat_arsenal_ball_id_idx ON stat_arsenal (ball_id);

-- Per install and ball: totals over all games bowled with that ball.
CREATE TABLE stat_ball_games (
  install_hash text    NOT NULL REFERENCES stat_contributors ON DELETE CASCADE,
  ball_id      text    NOT NULL,
  games        integer NOT NULL CHECK (games > 0),
  total_score  integer NOT NULL CHECK (total_score BETWEEN 0 AND games * 300),
  high_score   integer NOT NULL CHECK (high_score BETWEEN 0 AND 300),
  strikes      integer NOT NULL DEFAULT 0 CHECK (strikes BETWEEN 0 AND games * 12),
  spares       integer NOT NULL DEFAULT 0 CHECK (spares BETWEEN 0 AND games * 10),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (install_hash, ball_id)
);
CREATE INDEX stat_ball_games_ball_id_idx ON stat_ball_games (ball_id);

-- Aggregated per ball (across weights). Score stats stay NULL until at least
-- 3 bowlers have used the ball, so one person's numbers are never exposed.
CREATE VIEW ball_stats AS
WITH arsenal AS (
  SELECT ball_id, count(*)::int AS arsenal_count
  FROM stat_arsenal GROUP BY ball_id
),
games AS (
  SELECT
    ball_id,
    count(*)::int        AS bowlers,
    sum(games)::int      AS games,
    sum(total_score)     AS total_score,
    max(high_score)      AS high_score,
    sum(strikes)         AS strikes,
    sum(spares)          AS spares
  FROM stat_ball_games GROUP BY ball_id
)
SELECT
  coalesce(a.ball_id, g.ball_id)            AS ball_id,
  coalesce(a.arsenal_count, 0)              AS arsenal_count,
  coalesce(g.bowlers, 0)                    AS bowlers,
  coalesce(g.games, 0)                      AS games,
  CASE WHEN g.bowlers >= 3 THEN round(g.total_score::numeric / g.games, 1) END AS average_score,
  CASE WHEN g.bowlers >= 3 THEN g.high_score END                               AS high_score,
  CASE WHEN g.bowlers >= 3 THEN round(g.strikes::numeric / g.games, 2) END     AS strikes_per_game,
  CASE WHEN g.bowlers >= 3 THEN round(g.spares::numeric / g.games, 2) END      AS spares_per_game
FROM arsenal a
FULL JOIN games g ON g.ball_id = a.ball_id;

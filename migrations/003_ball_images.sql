-- Copies of the bowwwl.com ball images on our own image host (Cloudflare R2,
-- images.lightningbowl.de), so the app doesn't load them from bowwwl.com.
--
-- Keyed by the image path as bowwwl.com gives it (`raw->>'ball_image'` etc.):
-- balls share images across weights, and a changed image gets a new path.
-- The API returns `url` once a copy exists and the bowwwl.com path until then.

CREATE TABLE ball_images (
  source       text PRIMARY KEY,           -- path or URL as in the upstream ball
  url          text,                       -- public URL of the copy, null until copied
  object_key   text,
  content_type text,
  bytes        integer,
  first_seen_at timestamptz,              -- newest ball using it, so new balls are copied first
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  mirrored_at  timestamptz,
  attempted_at timestamptz
);
CREATE INDEX ball_images_pending_idx ON ball_images (attempts, first_seen_at DESC) WHERE url IS NULL;

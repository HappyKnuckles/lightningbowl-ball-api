-- Image embeddings of the ball pictures, for finding a ball from a photo
-- (`POST /api/balls/image-search`). The embedder service (embedder/) turns an
-- image into a unit-length vector; similar pictures have vectors with a large
-- dot product.
--
-- Keyed like ball_images by the image path as bowwwl.com gives it
-- (`raw->>'ball_image'`), and by the model: a new model embeds every image
-- again, and only vectors of the same model are compared.
--
-- Plain `real[]` and a brute-force search, so it runs on any Postgres: a few
-- thousand pictures take a few hundred milliseconds. Past that, pgvector with
-- an HNSW index is the step up.

CREATE TABLE image_embeddings (
  source       text NOT NULL,              -- path or URL as in the upstream ball
  model        text NOT NULL,              -- as the embedder names it
  embedding    real[],                     -- unit length, null until embedded
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  attempted_at timestamptz,
  embedded_at  timestamptz,
  PRIMARY KEY (source, model)
);

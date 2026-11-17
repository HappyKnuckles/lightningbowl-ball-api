// Embeds all ball pictures that have no embedding yet, for image search:
// `npm run embed-images` (needs DATABASE_URL and EMBEDDER_URL; EMBED_CONCURRENCY for more pictures at once). The nightly sync
// embeds new pictures within its time budget; this is for the first fill.
import { existsSync } from 'node:fs';
import { closePool } from '../lib/db.js';
import { embedderFromEnv, embedImages } from '../lib/embeddings.js';
import { migrate } from '../lib/migrate.js';

if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL && existsSync('.env.local')) process.loadEnvFile('.env.local');

const embedder = embedderFromEnv();
if (!embedder) {
  console.error('Set EMBEDDER_URL (and EMBEDDER_KEY if the embedder needs one).');
  process.exit(1);
}

// pictures in flight at once; match the embedder's CONCURRENCY (plus a little, to cover loading the pictures)
const concurrency = Math.max(1, Number(process.env.EMBED_CONCURRENCY) || 4);

try {
  await migrate({ log: () => {} });
  console.log(`model: ${await embedder.model()}`);
  // in rounds, to report progress
  for (;;) {
    const stats = await embedImages({ embedder, limit: 200, concurrency, log: (message) => console.warn(message) });
    console.log(`embedded ${stats.embedded}, failed ${stats.failed}, ${stats.remaining} left`);
    if (stats.embedded + stats.failed === 0) break;
  }
} catch (error) {
  console.error('Embedding pictures failed:', (error as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}

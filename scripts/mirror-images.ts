// Copies all ball images that have no copy yet to R2: `npm run mirror-images`
// (needs DATABASE_URL and the R2_* variables). The nightly sync copies new
// images within its time budget; this is for the first fill of the catalog.
import { existsSync } from 'node:fs';
import { closePool } from '../lib/db.js';
import { mirrorImages } from '../lib/images.js';
import { migrate } from '../lib/migrate.js';
import { r2ConfigFromEnv, r2Store } from '../lib/r2.js';

if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL && existsSync('.env.local')) process.loadEnvFile('.env.local');

const config = r2ConfigFromEnv();
if (!config) {
  console.error('Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (R2_BUCKET_NAME, R2_PUBLIC_DOMAIN optional).');
  process.exit(1);
}

try {
  await migrate({ log: () => {} });
  const store = r2Store(config);
  // in rounds, to report progress
  for (;;) {
    const stats = await mirrorImages({ store, limit: 200, log: (message) => console.warn(message) });
    console.log(`copied ${stats.copied}, failed ${stats.failed}, ${(stats.bytes / 1024 / 1024).toFixed(1)} MB, ${stats.remaining} left`);
    if (stats.copied + stats.failed === 0) break;
  }
} catch (error) {
  console.error('Copying images failed:', (error as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}

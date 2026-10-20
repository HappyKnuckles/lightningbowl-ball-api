// Manual sync: `npm run sync` (needs DATABASE_URL).
import { existsSync } from 'node:fs';
import { closePool } from '../lib/db.js';
import { runSync } from '../lib/sync.js';

if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL && existsSync('.env.local')) process.loadEnvFile('.env.local');

try {
  const run = await runSync({ trigger: 'manual' });
  console.log(JSON.stringify(run, null, 2));
  if ('status' in run && run.status === 'failed') process.exitCode = 1;
} catch (error) {
  console.error('Sync failed:', (error as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}

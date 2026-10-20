import { existsSync } from 'node:fs';
import { closePool } from '../lib/db.js';
import { migrate } from '../lib/migrate.js';

if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL && existsSync('.env.local')) process.loadEnvFile('.env.local');

try {
  await migrate();
} catch (error) {
  console.error('Migration failed:', (error as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}

// Minimal forward-only migration runner: applies migrations/*.sql in name
// order, each in its own transaction, and records them in schema_migrations.
// Safe to call on every sync run: an advisory lock serialises concurrent
// callers and already-applied files are skipped.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, withTransaction } from './db.js';

const LOCK_ID = 727274; // arbitrary, unique to this app

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate({ log = console.log } = {}) {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const applied = new Set((await query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const pending = files.filter((f) => !applied.has(f));

  for (const file of pending) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const applied = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
      const { rowCount } = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (rowCount > 0) return false; // applied meanwhile by a concurrent caller
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      return true;
    });
    if (applied) log(`Applied ${file}`);
  }

  if (pending.length === 0) log('Database is up to date');
  return pending;
}

// Postgres access. Works with Neon (use the pooled connection string) and any
// regular Postgres. The pool is created lazily so tests can set DATABASE_URL
// first, and kept small because every serverless instance gets its own.
import pg from 'pg';

// Return `date` columns as 'YYYY-MM-DD' strings instead of local-time Date objects.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

let pool;

export function getPool() {
  if (!pool) {
    // DATABASE_URL is the Neon pooled string; POSTGRES_URL is the same value
    // under the name Vercel's Neon integration also sets.
    const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL (or POSTGRES_URL) is not set');
    }
    pool = new pg.Pool({
      connectionString,
      max: Number(process.env.DB_POOL_MAX || 3),
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
    });
    pool.on('error', (error) => console.error('Idle database client error:', error.message));
  }
  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}

/** Runs `fn(client)` inside a transaction (BEGIN … COMMIT / ROLLBACK). */
export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}

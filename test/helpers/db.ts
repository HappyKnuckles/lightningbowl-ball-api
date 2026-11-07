// Starts a throwaway Postgres for a test file and applies the migrations.
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { closePool, query } from '../../lib/db.js';
import { migrate } from '../../lib/migrate.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export async function startDatabase(): Promise<() => Promise<void>> {
  // Not created up front: initdb creates it (when tests run as root it runs as another user).
  const dir = path.join(os.tmpdir(), `ball-api-pg-${randomUUID()}`);
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {} });
  await pg.initialise();
  await pg.start();
  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/postgres`;
  await migrate({ log: () => {} });

  return async function stop() {
    await closePool();
    await pg.stop();
    await rm(dir, { recursive: true, force: true });
  };
}

export async function resetDatabase(): Promise<void> {
  await query('TRUNCATE balls, brands, cores, coverstocks, sync_runs, stat_contributors, ball_images RESTART IDENTITY CASCADE');
}

// GET /api/health — catalog size and the latest sync run.
import { withCors } from '../lib/cors.js';
import { query } from '../lib/db.js';
import type { ApiRequest, ApiResponse } from '../lib/http.js';
import { withErrorHandling } from '../lib/respond.js';
import type { Health, SyncRun } from '../lib/schemas.js';

async function handler(_req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await query('SELECT 1 FROM balls LIMIT 1');
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') {
      // undefined_table: migrations haven't run yet
      return res.status(503).json({
        status: 'not_initialized',
        hint: 'Run the sync once (Vercel → Settings → Cron Jobs → Run); it creates the tables and imports the catalog.',
      });
    }
    throw error;
  }

  const [{ rows: counts }, { rows: runs }] = await Promise.all([
    query<Health['counts']>(`SELECT
      (SELECT count(*)::int FROM balls WHERE removed_at IS NULL) AS balls,
      (SELECT count(*)::int FROM brands WHERE removed_at IS NULL) AS brands,
      (SELECT count(*)::int FROM cores WHERE removed_at IS NULL) AS cores,
      (SELECT count(*)::int FROM coverstocks WHERE removed_at IS NULL) AS coverstocks`),
    query<SyncRun>(`SELECT id, started_at, finished_at, status, trigger, stats, errors FROM sync_runs ORDER BY started_at DESC LIMIT 1`),
  ]);

  const body: Health = { status: runs[0] ? 'ok' : 'empty', counts: counts[0]!, lastSync: runs[0] ?? null };
  res.status(200).json(body);
}

export default withCors(withErrorHandling(handler));

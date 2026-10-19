// GET /api/health — catalog size and the latest sync run.
import { withCors } from '../lib/cors.js';
import { query } from '../lib/db.js';
import { withErrorHandling } from '../lib/respond.js';

async function handler(req, res) {
  const [{ rows: counts }, { rows: runs }] = await Promise.all([
    query(`SELECT
      (SELECT count(*)::int FROM balls WHERE removed_at IS NULL) AS balls,
      (SELECT count(*)::int FROM brands WHERE removed_at IS NULL) AS brands,
      (SELECT count(*)::int FROM cores WHERE removed_at IS NULL) AS cores,
      (SELECT count(*)::int FROM coverstocks WHERE removed_at IS NULL) AS coverstocks`),
    query(`SELECT id, started_at, finished_at, status, trigger, stats, errors FROM sync_runs ORDER BY started_at DESC LIMIT 1`),
  ]);

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ status: 'ok', counts: counts[0], lastSync: runs[0] ?? null });
}

export default withCors(withErrorHandling(handler));

// GET /api/cron/sync — called nightly by Vercel Cron (see vercel.json).
// Vercel sends `Authorization: Bearer $CRON_SECRET`; anything else is rejected.
import { timingSafeEqual } from 'node:crypto';
import { runSync } from '../../lib/sync.js';

function authorized(header) {
  const secret = process.env.CRON_SECRET;
  if (!secret || typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured' });
  }
  if (!authorized(req.headers.authorization)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const run = await runSync({ trigger: 'cron' });
    res.status(run.skipped ? 409 : run.status === 'failed' ? 502 : 200).json(run);
  } catch (error) {
    console.error('Sync failed:', error);
    res.status(500).json({ error: 'Sync failed' });
  }
}

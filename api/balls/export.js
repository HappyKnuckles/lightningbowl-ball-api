// GET /api/balls/export[?weight=lbs] — the whole active catalog (optionally one
// weight) as a plain array, newest first. For clients that keep an offline copy.
import { withCors } from '../../middleware.js';
import { exportBalls } from '../../lib/balls.js';
import { parseNumber } from '../../lib/params.js';
import { sendJson, withErrorHandling } from '../../lib/respond.js';

async function handler(req, res) {
  const weight = parseNumber('weight', req.query.weight, { min: 0, max: 20 });
  sendJson(res, await exportBalls(weight), { maxAge: 3600, staleWhileRevalidate: 86400 });
}

export default withCors(withErrorHandling(handler));

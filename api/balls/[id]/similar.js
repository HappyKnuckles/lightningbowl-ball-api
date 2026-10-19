// GET /api/balls/{id}/similar[?weight=lbs][&limit=n] — similar reaction, newest first.
import { withCors } from '../../../middleware.js';
import { findSimilarBalls } from '../../../lib/balls.js';
import { parseInteger, parseNumber, parseRequired } from '../../../lib/params.js';
import { sendJson, withErrorHandling } from '../../../lib/respond.js';

async function handler(req, res) {
  const id = parseRequired('id', req.query.id);
  const weight = parseNumber('weight', req.query.weight, { min: 0, max: 20 });
  const limit = parseInteger('limit', req.query.limit, { min: 1, max: 50 }) ?? 10;

  const similar = await findSimilarBalls(id, weight, limit);
  if (similar === null) {
    return res.status(404).json({ error: 'Ball not found' });
  }
  sendJson(res, similar);
}

export default withCors(withErrorHandling(handler));

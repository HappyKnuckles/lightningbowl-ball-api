// GET /api/balls/{id}[?weight=lbs] — all weight variants of one ball.
import { withCors } from '../../../lib/cors.js';
import { findBallVariants } from '../../../lib/balls.js';
import { parseNumber, parseRequired } from '../../../lib/params.js';
import { sendJson, withErrorHandling } from '../../../lib/respond.js';

async function handler(req, res) {
  const id = parseRequired('id', req.query.id);
  const weight = parseNumber('weight', req.query.weight, { min: 0, max: 20 });

  const variants = await findBallVariants(id, weight);
  if (variants.length === 0) {
    return res.status(404).json({ error: 'Ball not found' });
  }
  sendJson(res, variants);
}

export default withCors(withErrorHandling(handler));

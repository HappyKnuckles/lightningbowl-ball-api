// GET /api/balls/{id}[?weight=lbs] — all weight variants of one ball.
import { findBallVariants } from '../../../lib/balls.js';
import { withCors } from '../../../lib/cors.js';
import type { ApiRequest, ApiResponse } from '../../../lib/http.js';
import { sendJson, withErrorHandling } from '../../../lib/respond.js';
import { BallIdPath, parseQuery, WeightQuery } from '../../../lib/schemas.js';

async function handler(req: ApiRequest, res: ApiResponse) {
  const { id } = parseQuery(BallIdPath, req.query);
  const { weight } = parseQuery(WeightQuery, req.query);

  const variants = await findBallVariants(id, weight);
  if (variants.length === 0) {
    return res.status(404).json({ error: 'Ball not found' });
  }
  sendJson(res, variants);
}

export default withCors(withErrorHandling(handler));

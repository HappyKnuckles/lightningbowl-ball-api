// GET /api/balls/{id}/similar[?weight=lbs][&limit=n] — similar reaction, newest first.
import { findSimilarBalls } from '../../../lib/balls.js';
import { withCors } from '../../../lib/cors.js';
import type { ApiRequest, ApiResponse } from '../../../lib/http.js';
import { sendJson, withErrorHandling } from '../../../lib/respond.js';
import { BallIdPath, parseQuery, SimilarQuery } from '../../../lib/schemas.js';

async function handler(req: ApiRequest, res: ApiResponse) {
  const { id } = parseQuery(BallIdPath, req.query);
  const { weight, limit } = parseQuery(SimilarQuery, req.query);

  const similar = await findSimilarBalls(id, weight, limit);
  if (similar === null) {
    return res.status(404).json({ error: 'Ball not found' });
  }
  sendJson(res, similar);
}

export default withCors(withErrorHandling(handler));

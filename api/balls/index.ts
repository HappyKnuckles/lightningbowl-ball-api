// GET /api/balls — search, filter, sort and page the catalog.
import { findBalls } from '../../lib/balls.js';
import { withCors } from '../../lib/cors.js';
import type { ApiRequest, ApiResponse } from '../../lib/http.js';
import { sendJson, withErrorHandling } from '../../lib/respond.js';
import { BallQuery, parseQuery } from '../../lib/schemas.js';

async function handler(req: ApiRequest, res: ApiResponse) {
  sendJson(res, await findBalls(parseQuery(BallQuery, req.query)));
}

export default withCors(withErrorHandling(handler));

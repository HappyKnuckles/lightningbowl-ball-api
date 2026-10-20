// GET /api/balls/export[?weight=lbs] — the whole active catalog (optionally one
// weight) as a plain array, newest first. For clients that keep an offline copy.
import { exportBalls } from '../../lib/balls.js';
import { withCors } from '../../lib/cors.js';
import type { ApiRequest, ApiResponse } from '../../lib/http.js';
import { sendJson, withErrorHandling } from '../../lib/respond.js';
import { parseQuery, WeightQuery } from '../../lib/schemas.js';

async function handler(req: ApiRequest, res: ApiResponse) {
  const { weight } = parseQuery(WeightQuery, req.query);
  sendJson(res, await exportBalls(weight), { maxAge: 3600, staleWhileRevalidate: 86400 });
}

export default withCors(withErrorHandling(handler));

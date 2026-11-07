// GET /api/balls/export[?weight=lbs] — the whole active catalog (optionally one
// weight) as a plain array, newest first. Needs ADMIN_SECRET: it hands out the
// whole bowwwl.com catalog in one request.
import { exportBalls } from '../../lib/balls.js';
import { requireSecret } from '../../lib/auth.js';
import { withCors } from '../../lib/cors.js';
import type { ApiRequest, ApiResponse } from '../../lib/http.js';
import { withErrorHandling } from '../../lib/respond.js';
import { parseQuery, WeightQuery } from '../../lib/schemas.js';

async function handler(req: ApiRequest, res: ApiResponse) {
  const { weight } = parseQuery(WeightQuery, req.query);
  // not through sendJson: its public CDN caching would hand the catalog to anyone
  res.status(200).json(await exportBalls(weight));
}

export default withCors(requireSecret('ADMIN_SECRET', withErrorHandling(handler)));

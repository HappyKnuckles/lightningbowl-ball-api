// GET /api/coverstocks — optional search, brand, sort, page/size.
import { findCatalog } from '../lib/catalog.js';
import { withCors } from '../lib/cors.js';
import type { ApiRequest, ApiResponse } from '../lib/http.js';
import { sendJson, withErrorHandling } from '../lib/respond.js';

async function handler(req: ApiRequest, res: ApiResponse) {
  sendJson(res, await findCatalog('coverstocks', req.query), { maxAge: 3600, staleWhileRevalidate: 86400 });
}

export default withCors(withErrorHandling(handler));

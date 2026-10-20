// GET /api/cores — optional search, brand, sort, page/size.
import { withCors } from '../lib/cors.js';
import { findCatalog } from '../lib/catalog.js';
import { sendJson, withErrorHandling } from '../lib/respond.js';

async function handler(req, res) {
  sendJson(res, await findCatalog('cores', req.query), { maxAge: 3600, staleWhileRevalidate: 86400 });
}

export default withCors(withErrorHandling(handler));

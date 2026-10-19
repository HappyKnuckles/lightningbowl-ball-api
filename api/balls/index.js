// GET /api/balls — search, filter, sort and page the catalog.
import { withCors } from '../../middleware.js';
import { findBalls, parseBallQuery } from '../../lib/balls.js';
import { sendJson, withErrorHandling } from '../../lib/respond.js';

async function handler(req, res) {
  sendJson(res, await findBalls(parseBallQuery(req.query)));
}

export default withCors(withErrorHandling(handler));

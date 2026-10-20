// GET /api/openapi.json (rewritten to /api/openapi) — the OpenAPI document.
// Public and readable from any origin, so code generators can fetch it.
import type { ApiRequest, ApiResponse } from '../lib/http.js';
import { buildOpenApi } from '../lib/openapi.js';

const document = buildOpenApi();

export default function handler(_req: ApiRequest, res: ApiResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
  res.status(200).json(document);
}

import type { ApiRequest, ApiResponse, Handler } from './http.js';
import { BadRequestError } from './schemas.js';

/** JSON with CDN caching. Varies by Origin because the CORS headers do. */
export function sendJson(res: ApiResponse, body: unknown, { maxAge = 300, staleWhileRevalidate = 3600 } = {}): void {
  res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`);
  res.setHeader('Vary', 'Origin');
  res.status(200).json(body);
}

export function withErrorHandling(handler: Handler): Handler {
  return async (req: ApiRequest, res: ApiResponse) => {
    try {
      return await handler(req, res);
    } catch (error) {
      if (error instanceof BadRequestError) {
        return res.status(400).json({ error: error.message });
      }
      console.error('Handler error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

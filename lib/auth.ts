// Bearer-secret checks for the endpoints that aren't for the public:
// `/api/cron/sync` takes CRON_SECRET (Vercel Cron sends it), `/api/health` and
// `/api/balls/export` take ADMIN_SECRET. Send `Authorization: Bearer <secret>`.
import { timingSafeEqual } from 'node:crypto';
import type { ApiRequest, ApiResponse, Handler } from './http.js';

/** Whether the request carries `Authorization: Bearer <secret>`, compared in constant time. */
export function hasBearerSecret(req: ApiRequest, secret: string | undefined): boolean {
  const header = req.headers.authorization;
  if (!secret || typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Runs the handler only for requests with the secret from `envName`. Without the variable the
 * endpoint is closed (500), so a missing setting never opens it up.
 */
export function requireSecret(envName: 'ADMIN_SECRET' | 'CRON_SECRET', handler: Handler): Handler {
  return (req: ApiRequest, res: ApiResponse) => {
    // whatever the outcome, no shared cache may keep or serve it
    res.setHeader('Cache-Control', 'private, no-store');
    const secret = process.env[envName];
    if (!secret) return res.status(500).json({ error: `${envName} is not configured` });
    if (!hasBearerSecret(req, secret)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return handler(req, res);
  };
}

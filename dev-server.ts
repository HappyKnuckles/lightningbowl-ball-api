// Local stand-in for Vercel's function routing: `npm run dev`.
// Loads .env.local if present and maps URL paths to the files in api/.
import { existsSync } from 'node:fs';
import http from 'node:http';

import ball from './api/balls/[id]/index.js';
import similar from './api/balls/[id]/similar.js';
import exportBalls from './api/balls/export.js';
import balls from './api/balls/index.js';
import brands from './api/brands.js';
import cores from './api/cores.js';
import coverstocks from './api/coverstocks.js';
import sync from './api/cron/sync.js';
import docs from './api/docs.js';
import health from './api/health.js';
import openapi from './api/openapi.js';
import type { ApiRequest, ApiResponse, Handler } from './lib/http.js';
import type { RawQuery } from './lib/schemas.js';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const PORT = Number(process.env.PORT || 3003);

const routes: [RegExp, Handler][] = [
  [/^\/api\/balls$/, balls],
  [/^\/api\/balls\/export$/, exportBalls],
  [/^\/api\/balls\/(?<id>[^/]+)$/, ball],
  [/^\/api\/balls\/(?<id>[^/]+)\/similar$/, similar],
  [/^\/api\/brands$/, brands],
  [/^\/api\/cores$/, cores],
  [/^\/api\/coverstocks$/, coverstocks],
  [/^\/api\/health$/, health],
  [/^\/api\/cron\/sync$/, sync],
  [/^\/api\/openapi(\.json)?$/, openapi],
  [/^\/api\/docs$/, docs],
];

function toApiResponse(res: http.ServerResponse): ApiResponse {
  const api: ApiResponse = {
    status(code) {
      res.statusCode = code;
      return api;
    },
    json(body) {
      if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(body));
    },
    setHeader: (name, value) => res.setHeader(name, value),
    end: (body) => res.end(body),
    get headersSent() {
      return res.headersSent;
    },
  };
  return api;
}

function queryObject(searchParams: URLSearchParams): RawQuery {
  const query: RawQuery = {};
  for (const [key, value] of searchParams) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  }
  return query;
}

http
  .createServer(async (req, res) => {
    const api = toApiResponse(res);
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;

    for (const [pattern, handler] of routes) {
      const match = pattern.exec(pathname);
      if (!match) continue;
      const params = Object.fromEntries(Object.entries(match.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      const apiReq: ApiRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        socket: req.socket,
        query: { ...queryObject(url.searchParams), ...params },
      };
      try {
        await handler(apiReq, api);
      } catch (error) {
        console.error(error);
        if (!res.headersSent) api.status(500).json({ error: 'Internal server error' });
      }
      return;
    }
    api.status(404).json({ error: 'Not found' });
  })
  .listen(PORT, () => console.log(`Ball API running at http://localhost:${PORT} (docs: /api/docs)`));

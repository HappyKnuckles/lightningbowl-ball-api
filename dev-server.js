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
import health from './api/health.js';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const PORT = Number(process.env.PORT || 3003);

const routes = [
  [/^\/api\/balls$/, balls],
  [/^\/api\/balls\/export$/, exportBalls],
  [/^\/api\/balls\/(?<id>[^/]+)$/, ball],
  [/^\/api\/balls\/(?<id>[^/]+)\/similar$/, similar],
  [/^\/api\/brands$/, brands],
  [/^\/api\/cores$/, cores],
  [/^\/api\/coverstocks$/, coverstocks],
  [/^\/api\/health$/, health],
  [/^\/api\/cron\/sync$/, sync],
];

function addResponseHelpers(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  };
}

function queryObject(searchParams) {
  const query = {};
  for (const [key, value] of searchParams) {
    if (query[key] === undefined) query[key] = value;
    else if (Array.isArray(query[key])) query[key].push(value);
    else query[key] = [query[key], value];
  }
  return query;
}

http
  .createServer(async (req, res) => {
    addResponseHelpers(res);
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;

    for (const [pattern, handler] of routes) {
      const match = pattern.exec(pathname);
      if (match) {
        req.query = {
          ...queryObject(url.searchParams),
          ...Object.fromEntries(Object.entries(match.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)])),
        };
        try {
          await handler(req, res);
        } catch (error) {
          console.error(error);
          if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
        }
        return;
      }
    }
    res.status(404).json({ error: 'Not found' });
  })
  .listen(PORT, () => console.log(`Ball API running at http://localhost:${PORT}`));

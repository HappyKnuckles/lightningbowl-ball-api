// Calls a Vercel-style handler with a fake request/response. The body goes
// through JSON like a real response, so Dates arrive as strings.
import type { ApiResponse, Handler } from '../../lib/http.js';
import type { RawQuery } from '../../lib/schemas.js';

export interface TestResponse {
  statusCode: number;
  headers: Record<string, string>;
  // Tests assert on many shapes; contract tests validate it against the schemas.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  text?: string;
}

let ip = 0;

export async function call(
  handler: Handler,
  query: RawQuery = {},
  { headers = {}, method = 'GET' }: { headers?: Record<string, string>; method?: string } = {},
) {
  const result: TestResponse = { statusCode: 200, headers: {}, body: undefined };
  const res: ApiResponse = {
    setHeader(name, value) {
      result.headers[name.toLowerCase()] = String(value);
    },
    status(code) {
      result.statusCode = code;
      return res;
    },
    json(body) {
      result.body = JSON.parse(JSON.stringify(body));
    },
    end(body) {
      result.text = body;
    },
  };
  // A fresh client IP per call keeps the in-memory rate limiter out of the way.
  ip++;
  await handler({ method, query, headers: { 'x-forwarded-for': `10.0.${Math.floor(ip / 250)}.${ip % 250}`, ...headers }, socket: {} }, res);
  return result;
}

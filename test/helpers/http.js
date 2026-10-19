// Calls a Vercel-style handler with a fake request/response.
let ip = 0;

export async function call(handler, query = {}, { headers = {}, method = 'GET' } = {}) {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
    },
    end() {},
  };
  // A fresh client IP per call keeps the in-memory rate limiter out of the way.
  await handler({ method, query, headers: { 'x-forwarded-for': `10.0.${Math.floor(++ip / 250)}.${ip % 250}`, ...headers }, socket: {} }, res);
  return res;
}

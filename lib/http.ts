// Minimal request/response shapes shared by Vercel's Node runtime and the
// local dev server (which adds the same helpers). Keeps handlers framework-free.
import type { IncomingHttpHeaders } from 'node:http';
import type { RawQuery } from './schemas.js';

export interface ApiRequest {
  method?: string;
  url?: string;
  query: RawQuery;
  headers: IncomingHttpHeaders;
  socket?: { remoteAddress?: string };
}

export interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
  send?(body: string): void;
  setHeader(name: string, value: string | number): unknown;
  end(body?: string): void;
  headersSent?: boolean;
}

export type Handler = (req: ApiRequest, res: ApiResponse) => unknown;

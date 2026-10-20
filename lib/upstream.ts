// Fetching from the bowwwl.com REST API with timeouts and retries.

export const UPSTREAM_BASE = process.env.BOWWWL_API_BASE || 'https://bowwwl.com/restapi';

const USER_AGENT = 'lightningbowl-ball-api/1.0';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GETs a JSON array. Retries network errors, timeouts and 5xx/429 responses
 * with exponential backoff; 4xx responses fail immediately.
 */
export type FetchFn = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export interface FetchOptions {
  fetchFn?: FetchFn;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
}

export async function fetchList(
  path: string,
  { fetchFn = fetch, timeoutMs = 30000, retries = 3, backoffMs = 2000 }: FetchOptions = {},
): Promise<unknown[]> {
  const url = `${UPSTREAM_BASE}${path}`;
  let lastError: Error = new Error(`${url}: no attempt made`);

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));

    let response;
    try {
      response = await fetchFn(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const err = error as Error;
      lastError = new Error(`${url}: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
      continue;
    }

    if (!response.ok) {
      lastError = new Error(`${url}: HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
      continue;
    }

    const data: unknown = await response.json();
    if (!Array.isArray(data)) {
      throw new Error(`${url}: expected a JSON array`);
    }
    return data;
  }

  throw lastError;
}

/**
 * Loads the catalog from the paged v2 endpoint (/balls/v2?page=N). bowwwl's
 * full-catalog endpoint (/balls?_format=json) is unreliable, v2 is what their
 * own site uses. v2 may ignore `page` and return everything at once, so
 * paging stops as soon as a page adds no new balls.
 */
export async function fetchV2Catalog(options: FetchOptions = {}, { batchSize = 4, maxPages = 400 } = {}): Promise<unknown[]> {
  const byKey = new Map<string, unknown>();
  const keyOf = (ball: unknown) => {
    const b = (ball ?? {}) as { ball_id?: unknown; core_weight?: unknown };
    return `${String(b.ball_id)}|${String(b.core_weight)}`;
  };
  const addPage = (page: unknown[]) => {
    let added = 0;
    for (const ball of page) {
      const key = keyOf(ball);
      if (!byKey.has(key)) {
        byKey.set(key, ball);
        added++;
      }
    }
    return added;
  };
  const getPage = (page: number) => fetchList(`/balls/v2?page=${page}`, { timeoutMs: 60000, ...options });

  // Pages 0 and 1 one at a time: if page 1 adds nothing, page 0 was everything
  // and the parallel batches below would just download the full list again.
  if (addPage(await getPage(0)) === 0) return [];
  if (addPage(await getPage(1)) === 0) return [...byKey.values()];

  for (let first = 2; first < maxPages; first += batchSize) {
    const pages = await Promise.all(Array.from({ length: batchSize }, (_, i) => getPage(first + i)));
    for (const page of pages) {
      if (addPage(page) === 0) return [...byKey.values()];
    }
  }
  return [...byKey.values()];
}

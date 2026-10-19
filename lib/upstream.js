// Fetching from the bowwwl.com REST API with timeouts and retries.

export const UPSTREAM_BASE = process.env.BOWWWL_API_BASE || 'https://bowwwl.com/restapi';

const USER_AGENT = 'lightningbowl-ball-api/1.0';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GETs a JSON array. Retries network errors, timeouts and 5xx/429 responses
 * with exponential backoff; 4xx responses fail immediately.
 */
export async function fetchList(path, { fetchFn = fetch, timeoutMs = 30000, retries = 3, backoffMs = 2000 } = {}) {
  const url = `${UPSTREAM_BASE}${path}`;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));

    let response;
    try {
      response = await fetchFn(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = new Error(`${url}: ${error.name === 'TimeoutError' ? 'timed out' : error.message}`);
      continue;
    }

    if (!response.ok) {
      lastError = new Error(`${url}: HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
      continue;
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      throw new Error(`${url}: expected a JSON array`);
    }
    return data;
  }

  throw lastError;
}

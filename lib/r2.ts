// Uploads to Cloudflare R2 through its S3 API, signed with AWS Signature V4
// (no SDK needed for single PUTs). Same bucket and public domain as the
// pattern charts: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
// R2_BUCKET_NAME (default pattern-charts), R2_PUBLIC_DOMAIN.
import { createHash, createHmac } from 'node:crypto';

export interface ImageStore {
  /** Public base URL objects are served from, without a trailing slash. */
  publicBase: string;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBase: string;
}

/** R2 settings from the environment, or null when they aren't all set. */
export function r2ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  return {
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET_NAME || 'pattern-charts',
    publicBase: (env.R2_PUBLIC_DOMAIN || 'https://images.lightningbowl.de').replace(/\/+$/, ''),
  };
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** Headers for a signed S3 request (AWS Signature V4; R2's region is "auto"; no query string). */
export function signS3Request(
  { method, url, headers, body }: { method: string; url: URL; headers: Record<string, string>; body: Uint8Array },
  { accessKeyId, secretAccessKey }: Pick<R2Config, 'accessKeyId' | 'secretAccessKey'>,
  now = new Date(),
  region = 'auto',
): Record<string, string> {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const payloadHash = sha256(body);

  const all: Record<string, string> = { ...headers, host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(all)
    .map((name) => name.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(all).map(([name, value]) => [name.toLowerCase(), value.trim()]));
  const canonicalHeaders = names.map((name) => `${name}:${lower[name]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const { host: _host, ...rest } = all;
  return { ...rest, Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

export function r2Store(config: R2Config, fetchFn: typeof fetch = fetch): ImageStore {
  return {
    publicBase: config.publicBase,
    async put(key, body, contentType) {
      const url = new URL(`https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`);
      const headers = signS3Request(
        {
          method: 'PUT',
          url,
          body,
          // images are stored under a key derived from their source, so they never change
          headers: { 'content-type': contentType, 'cache-control': 'public, max-age=31536000, immutable' },
        },
        config,
      );
      const response = await fetchFn(url, { method: 'PUT', headers, body, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`R2 PUT ${key}: HTTP ${response.status}`);
    },
  };
}

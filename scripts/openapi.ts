// Writes openapi.json (committed, so clients can generate types from GitHub).
// `npm run openapi` after changing lib/schemas.ts; a test fails if it's stale.
import { writeFileSync } from 'node:fs';
import { buildOpenApi } from '../lib/openapi.js';

export const serializeOpenApi = (): string => `${JSON.stringify(buildOpenApi(), null, 2)}\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync('openapi.json', serializeOpenApi());
  console.log('Wrote openapi.json');
}

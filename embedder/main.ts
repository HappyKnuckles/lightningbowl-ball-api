// Starts the embedder: `npm start`. `npm run download` only fetches the model (the Docker build does
// that, so the container starts without network access to Hugging Face).
//
// MODEL      a CLIP or DINOv2 checkpoint in ONNX form (default Xenova/clip-vit-base-patch32;
//            onnx-community/dinov2-small or -base for DINOv2)
// DTYPE      its weights: q8 (default; small and fast on a CPU), fp16 or fp32
// MODEL_DIR  where models are kept (default ./models)
// API_KEY    when set, required as `Authorization: Bearer <key>` (the Ball API's EMBEDDER_KEY)
// PORT       default 8080
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '@huggingface/transformers';
import { loadModel, parseDtype } from './model.ts';
import { createEmbedderServer } from './server.ts';

env.cacheDir = process.env.MODEL_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'models');

const checkpoint = process.env.MODEL || 'Xenova/clip-vit-base-patch32';
const started = Date.now();
const model = await loadModel(checkpoint, parseDtype(process.env.DTYPE));
console.log(`${model.name} loaded (${model.dim} dimensions) in ${((Date.now() - started) / 1000).toFixed(1)} s`);

if (!process.argv.includes('--download')) {
  if (!process.env.API_KEY) console.warn('API_KEY is not set: anyone who can reach this port can use it');
  const port = Number(process.env.PORT || 8080);
  createEmbedderServer(model, { key: process.env.API_KEY || undefined }).listen(port, () => console.log(`Embedder listening on :${port}`));
}

// POST /api/balls/image-search[?weight=lbs][&limit=n] — the balls that look most like a photo.
// Body: { "image": "<base64 JPEG/PNG/WebP>" }. Needs the embedder service (EMBEDDER_URL).
import { withCors } from '../../lib/cors.js';
import { decodeImage, type Embedder, EmbedderError, embedderFromEnv, findBallsByImage, ImageRejectedError } from '../../lib/embeddings.js';
import type { ApiRequest, ApiResponse, Handler } from '../../lib/http.js';
import { withErrorHandling } from '../../lib/respond.js';
import { BadRequestError, ImageSearchQuery, ImageSearchRequest, MAX_SEARCH_IMAGE_BYTES, parseBody, parseQuery } from '../../lib/schemas.js';

/** The handler, with the embedder to use (from the environment when the endpoint runs). */
export function imageSearchHandler(getEmbedder: () => Embedder | null = embedderFromEnv): Handler {
  return withErrorHandling(async (req: ApiRequest, res: ApiResponse) => {
    // every photo is different; nothing to cache
    res.setHeader('Cache-Control', 'private, no-store');
    const { weight, limit } = parseQuery(ImageSearchQuery, req.query);
    const { image } = parseBody(ImageSearchRequest, req.body);
    const photo = decodeImage(image, MAX_SEARCH_IMAGE_BYTES);
    if (!photo) throw new BadRequestError(`Field "image" must be a base64 JPEG, PNG or WebP of at most ${MAX_SEARCH_IMAGE_BYTES / 1024 / 1024} MB`);

    const embedder = getEmbedder();
    if (!embedder) return res.status(503).json({ error: 'Image search is not set up' });

    let embedding;
    try {
      embedding = await embedder.embed(photo.bytes, photo.contentType);
    } catch (error) {
      if (error instanceof ImageRejectedError) throw new BadRequestError('Field "image" could not be read as a picture');
      if (error instanceof EmbedderError) {
        console.error('Image search:', error.message);
        return res.status(502).json({ error: 'Image search is unavailable, try again later' });
      }
      throw error;
    }
    res.status(200).json(await findBallsByImage(embedding, { weight, limit }));
  });
}

export default withCors(imageSearchHandler(), { method: 'POST' });

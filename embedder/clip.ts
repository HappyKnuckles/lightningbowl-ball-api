// CLIP's image encoder through transformers.js (ONNX Runtime on the CPU).
import { AutoImageProcessor, CLIPVisionModelWithProjection, RawImage } from '@huggingface/transformers';
import sharp from 'sharp';
import { type ImageModel, UnreadableImageError } from './server.ts';

/** Phone photos can be huge; CLIP looks at 224 px, so anything past this is shrunk first. */
const WORKING_SIZE = 448;

/**
 * The picture as upright RGB: turned as its EXIF says, transparency on white (the catalog's
 * pictures are cut-outs, mostly on white), shrunk to about WORKING_SIZE on its short side.
 */
export async function readPicture(bytes: Uint8Array): Promise<RawImage> {
  try {
    const { data, info } = await sharp(bytes, { limitInputPixels: 50_000_000 })
      .rotate()
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .removeAlpha()
      .resize({ width: WORKING_SIZE, height: WORKING_SIZE, fit: 'outside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return new RawImage(new Uint8ClampedArray(data), info.width, info.height, 3);
  } catch (error) {
    throw new UnreadableImageError(`not a picture: ${(error as Error).message}`);
  }
}

export function unitLength(vector: ArrayLike<number>): number[] {
  const values = Array.from(vector);
  const length = Math.hypot(...values);
  return values.map((v) => v / length);
}

/** Loads (and downloads, the first time) a CLIP checkpoint in ONNX form, e.g. Xenova/clip-vit-base-patch32. */
export async function loadClip(name: string): Promise<ImageModel> {
  const processor = await AutoImageProcessor.from_pretrained(name);
  const vision = await CLIPVisionModelWithProjection.from_pretrained(name, { dtype: 'fp32' });

  const embed = async (bytes: Uint8Array) => {
    const inputs = await processor(await readPicture(bytes));
    const { image_embeds } = await vision(inputs);
    return unitLength(image_embeds.data as Float32Array);
  };

  // also warms the model up, so the first real request isn't slow
  const blank = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
  const dim = (await embed(new Uint8Array(blank))).length;
  return { name, dim, embed };
}

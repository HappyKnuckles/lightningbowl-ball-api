// The image model through transformers.js (ONNX Runtime on the CPU): CLIP's image encoder or DINOv2.
import { AutoConfig, AutoImageProcessor, AutoModel, CLIPVisionModelWithProjection, RawImage, type Tensor } from '@huggingface/transformers';
import sharp from 'sharp';
import { type ImageModel, UnreadableImageError } from './server.ts';

/** Phone photos can be huge; the models look at 224 px, so anything past this is shrunk first. */
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

/** Weight formats a checkpoint can come in; q8 is about a quarter the size of fp32 and roughly twice as fast on a CPU. */
export const DTYPES = ['fp32', 'fp16', 'q8'] as const;
export type Dtype = (typeof DTYPES)[number];

export function parseDtype(value: string | undefined): Dtype {
  const dtype = (value || 'q8') as Dtype;
  if (!DTYPES.includes(dtype)) throw new Error(`DTYPE must be one of ${DTYPES.join(', ')}, not ${value}`);
  return dtype;
}

/**
 * The model's name as the Ball API stores it next to each vector. The weight format is part of it: other
 * weights give slightly different vectors, so switching makes the API embed every picture again.
 */
export function modelName(checkpoint: string, dtype: Dtype): string {
  return dtype === 'fp32' ? checkpoint : `${checkpoint}@${dtype}`;
}

/**
 * The vector of one picture, by model family:
 * - CLIP (`clip`): the image embedding, the image side of what CLIP learned from captioned pictures.
 * - DINOv2 (`dinov2`, `dinov2_with_registers`): the class token. Learned from pictures alone, it tells
 *   apart individual objects better and pays far less attention to printed text.
 */
type Encoder = (inputs: Record<string, Tensor>) => Promise<Tensor>;

async function loadEncoder(checkpoint: string, dtype: Dtype): Promise<Encoder> {
  const { model_type: family } = await AutoConfig.from_pretrained(checkpoint);
  if (family === 'clip') {
    const vision = await CLIPVisionModelWithProjection.from_pretrained(checkpoint, { dtype });
    return async (inputs) => (await vision(inputs)).image_embeds;
  }
  if (family === 'dinov2' || family === 'dinov2_with_registers') {
    const model = await AutoModel.from_pretrained(checkpoint, { dtype });
    return async (inputs) => (await model(inputs)).pooler_output;
  }
  throw new Error(`${checkpoint} is a ${family} model; the embedder knows CLIP and DINOv2`);
}

/**
 * Loads (and downloads, the first time) an image model in ONNX form: a CLIP checkpoint such as
 * Xenova/clip-vit-base-patch32, or DINOv2 such as onnx-community/dinov2-small.
 */
export async function loadModel(checkpoint: string, dtype: Dtype = 'q8'): Promise<ImageModel> {
  const processor = await AutoImageProcessor.from_pretrained(checkpoint);
  const encode = await loadEncoder(checkpoint, dtype);

  const embed = async (bytes: Uint8Array) => {
    const inputs = await processor(await readPicture(bytes));
    return unitLength((await encode(inputs)).data as Float32Array);
  };

  // also warms the model up, so the first real request isn't slow
  const blank = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
  const dim = (await embed(new Uint8Array(blank))).length;
  return { name: modelName(checkpoint, dtype), dim, embed };
}

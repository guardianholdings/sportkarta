import sharp from 'sharp';

// Server-side processing for anonymous report photos (docs/ROADMAP.md 2.2):
// re-encode to strip ALL metadata — most importantly EXIF GPS, which would
// otherwise leak the reporter's location (no PII; photos of facilities, not
// people). Orientation is baked in first so the visible image stays upright.

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // 8 MB upload cap
const MAX_DIMENSION = 1600; // px, longest side
// Reject decompression bombs: a small file can decode to an enormous canvas.
// 50 MP is generous for phone photos (~12 MP) yet far below sharp's ~268 MP default.
const MAX_INPUT_PIXELS = 50_000_000;
const ACCEPTED_INPUT = new Set(['jpeg', 'jpg', 'png', 'webp']);

export class InvalidPhotoError extends Error {}

export interface ProcessedPhoto {
  data: Buffer;
  contentType: 'image/webp';
  extension: 'webp';
}

/**
 * Validate + normalize an uploaded image: reject non-images and oversize input,
 * apply EXIF orientation, downscale to fit MAX_DIMENSION, and re-encode as WebP
 * WITHOUT metadata (sharp drops it unless `withMetadata()` is called). The
 * output therefore carries no EXIF/GPS/thumbnail data.
 */
export async function processReportPhoto(input: Uint8Array): Promise<ProcessedPhoto> {
  if (input.byteLength === 0) throw new InvalidPhotoError('empty file');
  if (input.byteLength > MAX_PHOTO_BYTES) throw new InvalidPhotoError('file too large');

  const buffer = Buffer.from(input);

  // `failOn: 'error'` rejects truncated/malformed images rather than best-effort.
  const pipeline = sharp(buffer, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS });
  let format: string | undefined;
  try {
    format = (await pipeline.metadata()).format;
  } catch {
    throw new InvalidPhotoError('not a valid image');
  }
  if (!format || !ACCEPTED_INPUT.has(format)) {
    throw new InvalidPhotoError(`unsupported image format: ${String(format)}`);
  }

  const data = await pipeline
    .rotate() // apply EXIF orientation before it is stripped
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 80 })
    .toBuffer();

  return { data, contentType: 'image/webp', extension: 'webp' };
}

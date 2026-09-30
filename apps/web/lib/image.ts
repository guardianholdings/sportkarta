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

/**
 * LOADER ALLOWLIST, ENFORCED INSIDE LIBVIPS. This pipeline is reachable without
 * an account (the problem-report form), so every native image parser sharp
 * ships is pre-auth attack surface — and libheif, the GIF, TIFF and VIPS
 * loaders have all had memory-corruption advisories against exactly this use
 * (GHSA-rgj7-g3m4-5g8c, GHSA-f88m-g3jw-g9cj). The format check that used to
 * guard this ran AFTER `metadata()`, i.e. after a loader had already parsed the
 * attacker's bytes.
 *
 * So every loader is blocked, and only the three formats we accept are let
 * back in — and only their in-memory (Buffer) variants, which is the one way
 * this module feeds sharp. Blocking the base class (`VipsForeignLoad`) rather
 * than naming the dangerous ones means a loader added by a future libvips is
 * refused by default instead of silently widening the surface. It is
 * process-wide, which is fine: this module is the only sharp user at runtime
 * (next/image is off — next.config.ts `images.unoptimized`). Savers are
 * untouched. The sniff below is the first gate; this is the one that holds if
 * the sniff is ever wrong.
 */
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({
  operation: ['VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngBuffer', 'VipsForeignLoadWebpBuffer'],
});

export type SniffedImage = 'jpeg' | 'png' | 'webp';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function hasPrefix(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  if (bytes.byteLength < offset + prefix.length) return false;
  return prefix.every((value, i) => bytes[offset + i] === value);
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/**
 * Identify an upload by its magic bytes, in TypeScript, before any native
 * parser sees it. Only JPEG (FF D8 FF), PNG (the 8-byte signature) and WebP
 * (RIFF....WEBP) pass; everything else — HEIF/AVIF, GIF, TIFF, SVG, a renamed
 * executable — is refused here without reaching libvips at all. The browser's
 * declared type and the file name are never consulted: both are the uploader's
 * to choose.
 */
export function sniffImageType(bytes: Uint8Array): SniffedImage | null {
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (hasPrefix(bytes, PNG_SIGNATURE)) return 'png';
  if (hasPrefix(bytes, ascii('RIFF')) && hasPrefix(bytes, ascii('WEBP'), 8)) return 'webp';
  return null;
}

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

  // Before sharp is even constructed — see sniffImageType.
  const sniffed = sniffImageType(input);
  if (!sniffed) throw new InvalidPhotoError('unsupported image format');

  const buffer = Buffer.from(input);

  // `failOn: 'error'` rejects truncated/malformed images rather than best-effort.
  const pipeline = sharp(buffer, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS });
  let format: string | undefined;
  try {
    format = (await pipeline.metadata()).format;
  } catch {
    throw new InvalidPhotoError('not a valid image');
  }
  // The decoder must agree with the magic bytes. With the loader allowlist in
  // place a disagreement cannot name a dangerous format, but it does mean the
  // file is not what it claims to be, and that is reason enough to refuse it.
  if (format !== sniffed) {
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

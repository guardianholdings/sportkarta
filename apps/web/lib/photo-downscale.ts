/**
 * Shrinking a photo in the browser before a contribution form posts it.
 *
 * WHY THE CLIENT HAS TO DO THIS. Server actions accept a 10 MB body
 * (next.config.ts `serverActions.bodySizeLimit`), and Next truncates anything
 * larger BEFORE our code runs: the action dies with "Unexpected end of form",
 * the page becomes "Application error", and everything the member typed is
 * gone. The friendly "photo too large" check in lib/image.ts can therefore
 * only ever fire between 8 and 10 MB. Phones that save 50 or 108 MP JPEGs
 * produce 15–25 MB files as a matter of course, so the one reliable fix is to
 * never send them: decode, scale to CLIENT_MAX_EDGE, re-encode as JPEG. It also
 * saves the member's mobile data. The server check stays as the backstop.
 *
 * Nothing here is a privacy measure — the server re-encodes and strips all
 * metadata regardless (lib/image.ts). Re-encoding here happens to drop EXIF
 * too, which is harmless.
 *
 * Browser-only at call time, but importable anywhere: the pure helpers are
 * unit-tested in Node, and no server module is imported (lib/image.ts pulls in
 * sharp and must never reach a client bundle).
 */

/** What every contribution photo input accepts; lib/image.ts accepts the same three. */
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp';

/**
 * The server's cap, mirrored because lib/image.ts cannot be imported into a
 * client component. tests/photo-downscale.test.ts pins the two equal.
 */
export const MAX_UPLOAD_PHOTO_BYTES = 8 * 1024 * 1024;

/** Longest edge after shrinking. The server brings it down to its own maximum. */
export const CLIENT_MAX_EDGE = 2560;
export const CLIENT_JPEG_QUALITY = 0.85;

/**
 * At or below this size a file is sent untouched, without even decoding it: it
 * cannot threaten the body limit, and re-encoding an already-small JPEG only
 * costs quality and battery.
 */
export const PASS_THROUGH_BYTES = 2 * 1024 * 1024;

export function needsDownscaleAttempt(bytes: number): boolean {
  return bytes > PASS_THROUGH_BYTES;
}

/** Scale (width, height) so the longer edge is at most `maxEdge`; never enlarges. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = CLIENT_MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** `IMG_1234.HEIC.png` → `IMG_1234.HEIC.jpg`; a nameless blob → `photo.jpg`. */
export function jpegName(name: string): string {
  const base = name.replace(/\.[^./\\]*$/, '');
  return `${base || 'photo'}.jpg`;
}

/** Which file the form should send: the shrunk one only when it actually is smaller. */
export function pickSmaller(
  original: { size: number },
  shrunk: { size: number } | null,
): 'original' | 'shrunk' {
  return shrunk !== null && shrunk.size < original.size ? 'shrunk' : 'original';
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      // 'from-image' so a portrait phone photo stays upright once the EXIF
      // orientation tag is gone from the re-encoded file.
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // Older Safari rejects the options bag; the <img> path below still works.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/**
 * The file the form should send. Never throws: a photo the browser cannot
 * decode (an unrenamed HEIC on desktop Chrome, a corrupt file) comes back
 * unchanged, and the caller's size check plus the server's validation decide.
 */
export async function downscalePhoto(file: File): Promise<File> {
  if (!needsDownscaleAttempt(file.size)) return file;
  let decoded: Decoded | null = null;
  try {
    decoded = await decode(file);
    const target = fitWithin(decoded.width, decoded.height);
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext('2d');
    if (!context) return file;
    // JPEG has no alpha: a transparent PNG would otherwise come out black.
    context.fillStyle = 'white';
    context.fillRect(0, 0, target.width, target.height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(decoded.source, 0, 0, target.width, target.height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', CLIENT_JPEG_QUALITY);
    });
    if (!blob) return file;
    const shrunk = new File([blob], jpegName(file.name), { type: 'image/jpeg' });
    return pickSmaller(file, shrunk) === 'shrunk' ? shrunk : file;
  } catch {
    return file;
  } finally {
    decoded?.release();
  }
}

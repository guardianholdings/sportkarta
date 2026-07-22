import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { InvalidPhotoError, MAX_PHOTO_BYTES, processReportPhoto } from '../lib/image';

// Build a JPEG that carries EXIF metadata so we can prove the pipeline strips
// it. The pipeline strips ALL metadata unconditionally, so a re-encode that
// drops this EXIF necessarily drops any GPS IFD too (the privacy-critical case:
// no reporter location leaks). We assert on the EXIF buffer's presence/absence.
async function jpegWithExif(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 160, b: 90 } },
  })
    .withExif({ IFD0: { Copyright: 'SportKarta test', Software: 'vitest' } })
    .jpeg()
    .toBuffer();
}

describe('processReportPhoto', () => {
  it('setup sanity: the crafted input really carries EXIF', async () => {
    const input = await jpegWithExif(2000, 1000);
    expect(Buffer.isBuffer((await sharp(input).metadata()).exif)).toBe(true);
  });

  it('strips all EXIF metadata (incl. any GPS) and re-encodes to WebP', async () => {
    const input = await jpegWithExif(2000, 1000);
    const out = await processReportPhoto(input);

    expect(out.contentType).toBe('image/webp');
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe('webp');
    // No EXIF buffer at all => no GPS, no camera/software tags survive.
    expect(meta.exif).toBeUndefined();
  });

  it('downscales oversized images to the max dimension (no enlargement)', async () => {
    const big = await processReportPhoto(await jpegWithExif(2000, 1000));
    const bigMeta = await sharp(big.data).metadata();
    expect(bigMeta.width).toBe(1600);
    expect(bigMeta.height).toBe(800);

    // A small image is left at its own size, not enlarged.
    const small = await processReportPhoto(await jpegWithExif(320, 240));
    const smallMeta = await sharp(small.data).metadata();
    expect(smallMeta.width).toBe(320);
    expect(smallMeta.height).toBe(240);
  });

  it('bakes in EXIF orientation before stripping it', async () => {
    // Orientation 6 = rotate 90°: a 100×50 image should become 50×100.
    const rotated = await sharp({
      create: { width: 100, height: 50, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const out = await processReportPhoto(rotated);
    const meta = await sharp(out.data).metadata();
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(100);
    expect(meta.exif).toBeUndefined();
  });

  it('rejects non-image input', async () => {
    await expect(processReportPhoto(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toBeInstanceOf(
      InvalidPhotoError,
    );
  });

  it('rejects empty input', async () => {
    await expect(processReportPhoto(new Uint8Array(0))).rejects.toBeInstanceOf(InvalidPhotoError);
  });

  it('rejects input above the size cap before decoding', async () => {
    await expect(processReportPhoto(new Uint8Array(MAX_PHOTO_BYTES + 1))).rejects.toBeInstanceOf(
      InvalidPhotoError,
    );
  });
});

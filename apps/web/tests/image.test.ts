import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  InvalidPhotoError,
  MAX_PHOTO_BYTES,
  processReportPhoto,
  sniffImageType,
} from '../lib/image';

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

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// One tiny image in every format the upload form might be handed. The savers are
// not blocked (only loaders are), so these can be built in-process.
async function fixtures(): Promise<Record<string, Buffer>> {
  const base = sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 40, g: 90, b: 160 } },
  });
  return {
    jpeg: await base.clone().jpeg().toBuffer(),
    png: await base.clone().png().toBuffer(),
    webp: await base.clone().webp().toBuffer(),
    gif: await base.clone().gif().toBuffer(),
    tiff: await base.clone().tiff().toBuffer(),
    avif: await base.clone().avif().toBuffer(),
    svg: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>',
    ),
  };
}

describe('sniffImageType', () => {
  it('recognises exactly the three accepted formats by their magic bytes', async () => {
    const f = await fixtures();
    expect(sniffImageType(f.jpeg as Buffer)).toBe('jpeg');
    expect(sniffImageType(f.png as Buffer)).toBe('png');
    expect(sniffImageType(f.webp as Buffer)).toBe('webp');
  });

  it('refuses every other format, and anything too short to carry a signature', async () => {
    const f = await fixtures();
    for (const format of ['gif', 'tiff', 'avif', 'svg'] as const) {
      expect(sniffImageType(f[format] as Buffer), format).toBeNull();
    }
    expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
    // RIFF without the WEBP form type is a WAV or an AVI, not a photo.
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WAVEfmt '))).toBeNull();
  });
});

describe('the pre-auth parser surface', () => {
  it('refuses HEIF/AVIF, GIF, TIFF and SVG before sharp is involved', async () => {
    const f = await fixtures();
    for (const format of ['gif', 'tiff', 'avif', 'svg'] as const) {
      // The exact message is the sniff's own: a refusal that came from sharp
      // would read "not a valid image" or name the decoded format.
      await expect(processReportPhoto(f[format] as Buffer), format).rejects.toThrowError(
        new InvalidPhotoError('unsupported image format'),
      );
    }
  });

  it('keeps the dangerous loaders blocked inside libvips, not only in our check', async () => {
    // Importing lib/image installs the allowlist process-wide. Even a caller
    // that skipped the sniff could not reach these parsers.
    const f = await fixtures();
    for (const format of ['gif', 'tiff', 'avif', 'svg'] as const) {
      await expect(sharp(f[format] as Buffer).metadata(), format).rejects.toThrow();
    }
  });

  it('still accepts JPEG, PNG and WebP', async () => {
    const f = await fixtures();
    for (const format of ['jpeg', 'png', 'webp'] as const) {
      const out = await processReportPhoto(f[format] as Buffer);
      expect((await sharp(out.data).metadata()).format, format).toBe('webp');
    }
  });

  it('refuses a file whose magic bytes lie about what follows', async () => {
    const f = await fixtures();
    // A PNG signature glued onto a JPEG body, and a JPEG marker glued onto noise.
    const forgedPng = Buffer.concat([Buffer.from(PNG_MAGIC), f.jpeg as Buffer]);
    const forgedJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 7)]);
    await expect(processReportPhoto(forgedPng)).rejects.toBeInstanceOf(InvalidPhotoError);
    await expect(processReportPhoto(forgedJpeg)).rejects.toBeInstanceOf(InvalidPhotoError);
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MAX_PHOTO_BYTES } from '../lib/image';
import {
  CLIENT_MAX_EDGE,
  downscalePhoto,
  fitWithin,
  jpegName,
  MAX_UPLOAD_PHOTO_BYTES,
  needsDownscaleAttempt,
  PASS_THROUGH_BYTES,
  PHOTO_ACCEPT,
  pickSmaller,
} from '../lib/photo-downscale';

/**
 * Contribution photos (pre-launch audit, 2026-09).
 *
 * 1. A photo over the 10 MB server-action body limit crashed add, condition
 *    and report with "Application error" and lost the form — Next truncates
 *    the body before our own 8 MB check can answer. The browser now shrinks
 *    large photos first; these tests pin the arithmetic and the limits that
 *    make that safe.
 * 2. `capture="environment"` forced the camera on phones, so a photo taken
 *    earlier could not be attached — and on the add form the photo is required.
 */

const WEB_ROOT = process.cwd(); // vitest runs with cwd = apps/web
const MB = 1024 * 1024;

const PHOTO_FORMS = [
  'app/[locale]/dobavi/add-facility-form.tsx',
  'app/[locale]/obekt/[slug]/condition-form.tsx',
  'components/facility/report-form.tsx',
];

describe('the limits line up', () => {
  it('the client refuses exactly what the server refuses', () => {
    expect(MAX_UPLOAD_PHOTO_BYTES).toBe(MAX_PHOTO_BYTES);
  });

  it('anything the client lets through fits under the server-action body limit', () => {
    const config = readFileSync(path.join(WEB_ROOT, 'next.config.ts'), 'utf8');
    const match = /bodySizeLimit:\s*'(\d+)mb'/.exec(config);
    expect(match, 'next.config.ts must declare serverActions.bodySizeLimit in mb').not.toBeNull();
    const bodyLimit = Number(match?.[1]) * MB;
    // Headroom for the rest of the multipart body (name, sports, pin, token).
    expect(MAX_UPLOAD_PHOTO_BYTES).toBeLessThanOrEqual(bodyLimit - MB);
  });

  it('a small photo is never touched', () => {
    expect(needsDownscaleAttempt(PASS_THROUGH_BYTES)).toBe(false);
    expect(needsDownscaleAttempt(PASS_THROUGH_BYTES + 1)).toBe(true);
    expect(PASS_THROUGH_BYTES).toBeLessThan(MAX_UPLOAD_PHOTO_BYTES);
  });
});

describe('fitWithin', () => {
  it('scales the longer edge of a landscape photo to the cap', () => {
    // A 50 MP phone sensor.
    expect(fitWithin(8160, 6120)).toEqual({ width: CLIENT_MAX_EDGE, height: 1920 });
  });

  it('scales a portrait photo by its height', () => {
    expect(fitWithin(6120, 8160)).toEqual({ width: 1920, height: CLIENT_MAX_EDGE });
  });

  it('never enlarges', () => {
    expect(fitWithin(1200, 800)).toEqual({ width: 1200, height: 800 });
    expect(fitWithin(CLIENT_MAX_EDGE, 10)).toEqual({ width: CLIENT_MAX_EDGE, height: 10 });
  });

  it('never rounds an edge to nothing', () => {
    expect(fitWithin(100_000, 10)).toEqual({ width: CLIENT_MAX_EDGE, height: 1 });
  });
});

describe('the file that is sent', () => {
  it('is renamed to what it now is', () => {
    expect(jpegName('IMG_0042.PNG')).toBe('IMG_0042.jpg');
    expect(jpegName('pitch.photo.webp')).toBe('pitch.photo.jpg');
    expect(jpegName('')).toBe('photo.jpg');
    expect(jpegName('.jpg')).toBe('photo.jpg');
  });

  it('is the shrunk one only when it really is smaller', () => {
    expect(pickSmaller({ size: 15 * MB }, { size: 2 * MB })).toBe('shrunk');
    expect(pickSmaller({ size: 3 * MB }, { size: 4 * MB })).toBe('original');
    expect(pickSmaller({ size: 3 * MB }, null)).toBe('original');
  });

  it('passes a small file through untouched, without decoding it', async () => {
    const small = new File([new Uint8Array(1024)], 'pitch.jpg', { type: 'image/jpeg' });
    await expect(downscalePhoto(small)).resolves.toBe(small);
  });

  it('never throws on a file it cannot decode — the size check decides', async () => {
    // No canvas or image decoder in Node: exactly the "browser cannot read
    // this file" path (an unrenamed HEIC on desktop Chrome, a corrupt file).
    const big = new File([new Uint8Array(PASS_THROUGH_BYTES + 1)], 'x.jpg', { type: 'image/jpeg' });
    await expect(downscalePhoto(big)).resolves.toBe(big);
  });
});

describe('the photo inputs', () => {
  for (const file of PHOTO_FORMS) {
    const source = readFileSync(path.join(WEB_ROOT, file), 'utf8');

    it(`${file} lets the phone offer its library, not only the camera`, () => {
      expect(source).not.toMatch(/\bcapture=/);
    });

    it(`${file} shrinks the photo before it can be posted`, () => {
      expect(source).toContain('onChange={photo.onChange}');
      expect(source).toContain('accept={PHOTO_ACCEPT}');
    });
  }

  it('accepts the formats the server accepts', () => {
    expect(PHOTO_ACCEPT.split(',')).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });
});

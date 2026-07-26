import { describe, expect, it } from 'vitest';

import { renderStoryCard, STORY_SAFE_BOTTOM, STORY_SAFE_TOP, STORY_SIZE } from '../lib/og/story';

/**
 * The 1080×1920 story renders, with real Cyrillic, and needs no browser.
 *
 * Same reasoning as `og-render.test.ts` and the same two traps. NO CHROMIUM,
 * because production is `node:24-alpine` with no browser and no system fonts —
 * a test that needed one could not gate the thing it is gating. And the fixture
 * is BULGARIAN, because a Latin-only render passes happily with the wrong font
 * subset traced: the vendored fallback inside @vercel/og is Latin-only Noto
 * Sans, so asserting on Cyrillic is what makes the assertion mean "the cyrillic
 * subset shipped".
 *
 * The story is a separate renderer from the card, so it needs its own gate: the
 * card's test would stay green if `renderStoryCard` were emitting 1200×630, or
 * tofu, or nothing at all.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function bytesOf(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

/** PNG width and height live big-endian at bytes 16..24 of the IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('story rendering', () => {
  it('produces a real 1080x1920 PNG from Bulgarian text', { timeout: 30_000 }, async () => {
    const png = await bytesOf(
      renderStoryCard({
        eyebrow: 'тренировка',
        hero: '9.4',
        heroLabel: 'километра',
        title: 'Бягане в Южен парк',
        subtitle: 'Фитнес на открито — Щ Ж Ъ Ю Я',
        stats: [
          { value: '52', label: 'минути' },
          { value: '120', label: 'м изкачване' },
        ],
        wordmark: 'СпортКарта',
        callToAction: 'Намери своето място',
        attribution: '© OpenStreetMap · Protomaps',
      }) as unknown as Response,
    );

    expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
    // Not merely "a PNG": the STORY aspect ratio. A 1200×630 image posted as a
    // story is letterboxed into a strip, which is the whole reason this renderer
    // exists separately from the card.
    expect(pngSize(png)).toEqual({ width: 1080, height: 1920 });
    // A tofu-only render is far smaller than a real one.
    expect(png.byteLength).toBeGreaterThan(8_000);
  });

  it('renders with every optional field absent', { timeout: 30_000 }, async () => {
    const png = await bytesOf(
      renderStoryCard({
        hero: '3',
        heroLabel: 'тренировки',
        title: 'Тази седмица',
        wordmark: 'СпортКарта',
      }) as unknown as Response,
    );
    expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(pngSize(png)).toEqual({ width: 1080, height: 1920 });
  });

  /**
   * The safe area is the whole design: Instagram and Facebook overlay their own
   * chrome on roughly the top and bottom 250px of a story. A reserve that
   * shrinks below that puts the punchline under the reply box.
   */
  it('reserves enough room for the platforms’ own chrome', () => {
    expect(STORY_SIZE).toEqual({ width: 1080, height: 1920 });
    expect(STORY_SAFE_TOP).toBeGreaterThanOrEqual(250);
    expect(STORY_SAFE_BOTTOM).toBeGreaterThanOrEqual(250);
    // …and still leaves a usable band in the middle.
    expect(STORY_SIZE.height - STORY_SAFE_TOP - STORY_SAFE_BOTTOM).toBeGreaterThan(1_000);
  });
});

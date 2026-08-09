import { describe, expect, it } from 'vitest';

import { renderOgCard } from '../lib/og/card';

/**
 * The card actually renders, with real Cyrillic, and needs no browser.
 *
 * NO CHROMIUM. Production is `node:24-alpine` with no browser and no system
 * fonts; `next/og` carries its own wasm rasteriser and explicit font buffers,
 * which is the whole reason it was chosen over rendering an SVG with sharp —
 * that path resolves fonts through fontconfig and produces tofu in production
 * while passing every test on a developer's Mac. This test runs in plain vitest
 * for the same reason: if it needed a browser it could not gate the thing it is
 * gating.
 *
 * WHY THE FIXTURE IS BULGARIAN. A Latin-only render passes happily with the
 * WRONG font subset traced — the vendored fallback inside @vercel/og is
 * Latin-only Noto Sans. Asserting on "Фитнес на открито" is what makes the
 * assertion mean "the Cyrillic subset shipped".
 *
 * Slow on first call (~2s) because the wasm rasteriser initialises once per
 * process; subsequent renders are ~20ms.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function bytesOf(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

describe('OG card rendering', () => {
  it('produces a real 1200x630 PNG from Bulgarian text', { timeout: 30_000 }, async () => {
    const png = await bytesOf(
      renderOgCard({
        eyebrow: 'София · Триадица',
        title: 'Фитнес на открито — Южен парк',
        subtitle: 'фитнес · стрийт фитнес',
        wordmark: 'Повече от просто спорт',
        attribution: '© OpenStreetMap · Protomaps',
      }) as unknown as Response,
    );

    expect(png.subarray(0, 4).equals(PNG_MAGIC), 'not a PNG').toBe(true);
    // A tofu render still produces a PNG, but a page of identical boxes
    // compresses far smaller than real glyph coverage. 8 KB is comfortably below
    // a genuine render (~26 KB measured) and comfortably above an empty canvas.
    expect(png.length).toBeGreaterThan(8_000);

    // Dimensions from the IHDR chunk: bytes 16-23 are width and height, big-endian.
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });

  it('renders with every optional row omitted', { timeout: 30_000 }, async () => {
    // A missing field must remove its ROW, never print an empty band or "null".
    const png = await bytesOf(
      renderOgCard({ title: 'Без допълнения', wordmark: 'POPS' }) as unknown as Response,
    );
    expect(png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    expect(png.readUInt32BE(16)).toBe(1200);
  });

  it(
    'carries a long-lived cache header — correct for PUBLIC cards only',
    { timeout: 30_000 },
    () => {
      const res = renderOgCard({
        title: 'Кампания',
        wordmark: 'Повече от просто спорт',
      }) as unknown as Response;
      const cache = res.headers.get('cache-control') ?? '';
      expect(cache).toContain('public');
      // Pinned deliberately: this default is RIGHT here (a facility card names no
      // person) and WRONG for the person-scoped cards in C4/C5, where a one-year
      // immutable copy of a card naming a member is the frozen named artifact
      // migration 0012 forbids. Those need their own route with no-store.
      expect(cache).toMatch(/max-age=\d{7,}/);
    },
  );
});

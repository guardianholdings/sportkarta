import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OG_FONT_FILES } from '../lib/og/fonts';
import { OG_PALETTE, OG_PALETTE_TOKENS } from '../lib/og/palette';

/**
 * The two OG-card failures that are invisible until production.
 *
 * 1. MISSING FONT FILES → tofu. `next/og` carries a Latin-only Noto Sans
 *    fallback, so a card whose Cyrillic subset failed to ship does not error:
 *    it renders boxes where every Bulgarian title should be. The Docker web
 *    target copies only `.next/standalone`, `.next/static` and `public/`
 *    (Dockerfile:29), which is exactly why these live in `public/` rather than
 *    being read from node_modules — but only a test keeps them there.
 *
 * 2. PALETTE DRIFT. satori resolves no CSS variables, so the cards duplicate
 *    the token values as literal hex. Duplication that nothing checks is
 *    duplication that goes stale, and the failure is a card that no longer looks
 *    like the product.
 */

const WEB_ROOT = join(__dirname, '..');
const FONT_DIR = join(WEB_ROOT, 'public', 'fonts', 'og');
const COLORS_CSS = join(WEB_ROOT, 'app', 'design-tokens', 'colors.css');

describe('OG font assets', () => {
  it('every declared font file is present in public/', () => {
    for (const file of Object.values(OG_FONT_FILES)) {
      const path = join(FONT_DIR, file);
      expect(
        existsSync(path),
        `${file} is missing from public/fonts/og. The Docker image copies only ` +
          `public/, .next/standalone and .next/static — a font read from node_modules ` +
          `works in dev and renders TOFU in production.`,
      ).toBe(true);
    }
  });

  it('the files are real fonts, not empty or LFS pointers', () => {
    for (const file of Object.values(OG_FONT_FILES)) {
      const path = join(FONT_DIR, file);
      const size = statSync(path).size;
      expect(size, `${file} is implausibly small (${String(size)} bytes)`).toBeGreaterThan(2000);
      // woff magic number: 'wOFF'. Guards against a woff2 being copied under a
      // .woff name — satori cannot decode woff2, and the error is opaque.
      const magic = readFileSync(path).subarray(0, 4).toString('latin1');
      expect(magic, `${file} is not a WOFF (magic "${magic}")`).toBe('wOFF');
    }
  });

  it('uses the CYRILLIC subsets, not the latin ones', () => {
    // The single most likely wrong choice: @fontsource ships latin by default
    // and the latin file renders every Bulgarian title as tofu.
    for (const file of Object.values(OG_FONT_FILES)) {
      expect(file, `${file} must be a cyrillic subset`).toContain('cyrillic');
    }
  });

  it('uses .woff and never .woff2 — satori cannot decode woff2', () => {
    for (const file of Object.values(OG_FONT_FILES)) {
      expect(file.endsWith('.woff'), `${file} must be .woff`).toBe(true);
    }
  });
});

describe('OG palette mirrors the design tokens', () => {
  const css = readFileSync(COLORS_CSS, 'utf8');

  /** Resolve a token to a literal hex, following one level of var(). */
  function resolveToken(name: string): string {
    const direct = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
    expect(direct, `token --${name} not found in colors.css`).not.toBeNull();
    const value = (direct?.[1] ?? '').trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value.toUpperCase();
    const indirect = /^var\(--([a-z0-9-]+)\)$/.exec(value);
    expect(indirect, `--${name} is neither a hex nor a single var()`).not.toBeNull();
    return resolveToken(indirect?.[1] ?? '');
  }

  it('resolves the tokens it compares against (guards a vacuous pass)', () => {
    expect(resolveToken('paper')).toMatch(/^#[0-9A-F]{6}$/);
  });

  it('every OG colour still equals its token', () => {
    for (const [key, token] of Object.entries(OG_PALETTE_TOKENS)) {
      const mine = OG_PALETTE[key as keyof typeof OG_PALETTE].toUpperCase();
      expect(
        mine,
        `OG_PALETTE.${key} has drifted from --${token} in app/design-tokens/colors.css. ` +
          `satori resolves no CSS variables, so the card must duplicate the value — ` +
          `update the literal.`,
      ).toBe(resolveToken(token));
    }
  });

  it('every OG colour is registered for drift checking', () => {
    // A colour added to OG_PALETTE without a token entry would silently escape
    // the assertion above.
    expect(Object.keys(OG_PALETTE).sort()).toEqual(Object.keys(OG_PALETTE_TOKENS).sort());
  });
});

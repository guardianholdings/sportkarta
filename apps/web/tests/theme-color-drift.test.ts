import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Drift gate: the browser/PWA chrome colours must equal the design tokens.
 *
 * WHY. `viewport.themeColor` (app/[locale]/layout.tsx) and the manifest's
 * `theme_color` / `background_color` (app/manifest.ts) are the only three brand
 * colours in the product that CANNOT be expressed as a CSS custom property —
 * the browser reads them before any stylesheet, so they must be literal hex.
 *
 * That makes them the one place the token layer cannot reach, and
 * tests/no-hardcoded-design-values.test.ts does not scan either file (its
 * SCANNED_DIRS are components/ui, lib/design and app/[locale]/design-system).
 * The result: all three sat at their pre-seed shadcn scaffold values — teal
 * #0f766e and #f6f5f2 — through the entire design reconciliation.
 * RECONCILIATION.md C6 explicitly called for the change and nothing enforced
 * it, so it was simply never done, and every themed mobile browser and every
 * installed PWA framed a pine-and-clay page in teal.
 *
 * Fixed 2026-07-26. This test is the part that keeps it fixed: it parses the
 * real values out of app/design-tokens/colors.css, so the next palette change
 * fails here instead of silently drifting for another six months.
 */

const WEB_ROOT = join(__dirname, '..');
const COLORS_CSS = join(WEB_ROOT, 'app', 'design-tokens', 'colors.css');
const LAYOUT = join(WEB_ROOT, 'app', '[locale]', 'layout.tsx');
const MANIFEST = join(WEB_ROOT, 'app', 'manifest.ts');

const css = readFileSync(COLORS_CSS, 'utf8');

/**
 * Resolve a semantic token to a literal hex, following ONE level of var()
 * indirection (`--accent: var(--coral-500)` → `--coral-500: #FF4A2B`). That is
 * the whole shape the palette uses: semantic aliases over a raw scale.
 */
function resolveToken(name: string): string {
  const direct = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  expect(direct, `token --${name} not found in app/design-tokens/colors.css`).not.toBeNull();
  const value = (direct?.[1] ?? '').trim();
  const hex = /^#[0-9a-fA-F]{3,8}$/.exec(value);
  if (hex) return value.toUpperCase();
  const indirect = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  expect(
    indirect,
    `token --${name} resolves to "${value}", which is neither a hex nor a single var()`,
  ).not.toBeNull();
  return resolveToken(indirect?.[1] ?? '');
}

/** The literal assigned to `key` in a source file, ignoring commented-out lines. */
function literalFor(file: string, key: string): string {
  const src = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const m = new RegExp(`${key}:\\s*'(#[0-9a-fA-F]{3,8})'`).exec(src);
  expect(m, `${key} not found (as a plain hex literal) in ${file}`).not.toBeNull();
  return (m?.[1] ?? '').toUpperCase();
}

describe('theme colour drift', () => {
  it('resolves the tokens it is comparing against (guards a vacuous pass)', () => {
    expect(resolveToken('accent')).toMatch(/^#[0-9A-F]{6}$/);
    expect(resolveToken('paper')).toMatch(/^#[0-9A-F]{6}$/);
  });

  // Chrome tracks --accent, not --brand, since the POPS rebrand: the app icon
  // and favicon are the coral mark (docs/design/pops-brand/HANDOFF.md — coral
  // is „знакът"), and the browser/PWA frame must match the icon it sits behind.
  it('viewport.themeColor equals --accent (the mark coral)', () => {
    expect(
      literalFor(LAYOUT, 'themeColor'),
      'app/[locale]/layout.tsx viewport.themeColor has drifted from --accent in ' +
        'app/design-tokens/colors.css. The browser reads this before any CSS, so it ' +
        'cannot use a token — update the literal to match.',
    ).toBe(resolveToken('accent'));
  });

  it('manifest theme_color equals --accent (the mark coral)', () => {
    expect(literalFor(MANIFEST, 'theme_color')).toBe(resolveToken('accent'));
  });

  it('manifest background_color equals --paper', () => {
    expect(literalFor(MANIFEST, 'background_color')).toBe(resolveToken('paper'));
  });

  it('the pre-seed shadcn scaffold colours are gone for good', () => {
    // Named explicitly: these exact values survived a full design reconciliation
    // that had already flagged them (RECONCILIATION.md C6).
    //
    // Comments are stripped first, matching every other gate in this repo (see
    // no-hardcoded-design-values.test.ts: "A design value mentioned in a doc
    // comment is documentation, not code"). Both files now carry a comment
    // recording which value they used to hold and why it was wrong, and that
    // history is worth more than a stricter raw-text match.
    for (const file of [LAYOUT, MANIFEST]) {
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(src, `${file} still contains the pre-seed teal`).not.toMatch(/#0f766e/i);
      expect(src, `${file} still contains the pre-seed background`).not.toMatch(/#f6f5f2/i);
    }
  });
});

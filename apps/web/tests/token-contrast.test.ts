import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Colour-contrast gate on the token layer.
 *
 * The seed palette ("Trail & Summit") was adopted verbatim, and several of its
 * pairs do not meet WCAG 2.1 AA in the combinations this product actually
 * renders them in — the tertiary text colour on every surface, and every status
 * hue both as text on its own -bg and as a solid fill under white. Those were
 * corrected in app/design-tokens/colors.css; this test is what keeps them
 * corrected, because the failure mode is invisible in review (4.29:1 and 4.83:1
 * look identical) and the tokens are the kind of file that gets "restored to
 * the seed" by someone reconciling against the handoff.
 *
 * The ratios are computed from the token file itself, so re-tuning a hue is
 * allowed — shipping one that fails is not.
 *
 * Scope: only pairs that are genuinely rendered together. Activity blaze colours
 * are NOT checked as text; they are marker fills, always accompanied by an icon
 * and a text label (RECONCILIATION §3.1), and the marker glyph is checked at the
 * 3:1 non-text threshold instead.
 */

const TOKENS = readFileSync(join(__dirname, '..', 'app', 'design-tokens', 'colors.css'), 'utf8');

/**
 * Resolve a token to its hex. The semantic layer is deliberately indirect
 * (`--brand: var(--pine-600)`), so follow the chain rather than only matching
 * literals — otherwise the test silently skips exactly the tokens product code
 * consumes.
 */
function token(name: string, seen: ReadonlySet<string> = new Set()): string {
  if (seen.has(name)) throw new Error(`token --${name} is defined in terms of itself`);
  // Match the LAST definition (a later one would win in the cascade).
  const re = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6}\\b|var\\(--[a-z0-9-]+\\))`, 'g');
  let last: string | undefined;
  for (const m of TOKENS.matchAll(re)) last = m[1];
  if (!last) throw new Error(`token --${name} not found in colors.css`);
  const indirect = /^var\(--([a-z0-9-]+)\)$/.exec(last);
  return indirect ? token(indirect[1] as string, new Set([...seen, name])) : last;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const WHITE = '#FFFFFF';
/** Every surface a body/caption token is rendered on, darkest last. */
const SURFACES = ['surface', 'paper', 'surface-2', 'paper-sunk'] as const;

/** [foreground token, background token, minimum ratio, why] */
const TEXT_PAIRS: readonly (readonly [string, string, number, string])[] = [
  // Tertiary text: captions, stat labels, table meta — normal weight, small.
  ...SURFACES.map((s) => ['text-muted', s, 4.5, `tertiary text on --${s}`] as const),
  ...SURFACES.map((s) => ['ink-soft', s, 4.5, `secondary text on --${s}`] as const),
  ...SURFACES.map((s) => ['ink', s, 4.5, `primary text on --${s}`] as const),
  // Links and brand text.
  ['brand', 'paper', 4.5, 'link / brand text on the app background'],
  ['brand', 'surface', 4.5, 'link / brand text on a card'],
  ['brand', 'brand-subtle', 4.5, 'ghost button label on its own hover fill'],
  ['brand', 'brand-subtle-hover', 4.5, 'ghost button label on its :active fill'],
  // Status text on its own tinted background — every form error line.
  ['success', 'success-bg', 4.5, 'success message'],
  ['warning', 'warning-bg', 4.5, 'warning message'],
  ['danger', 'danger-bg', 4.5, 'error message (role="alert")'],
  ['info', 'info-bg', 4.5, 'info callout'],
  // Status text straight on the page (most role="alert" lines are unfilled).
  ['success', 'paper', 4.5, 'success message on the app background'],
  ['warning', 'paper', 4.5, 'warning message on the app background'],
  ['danger', 'paper', 4.5, 'error message on the app background'],
  ['info', 'paper', 4.5, 'info text on the app background'],
  ['accent-active', 'accent-subtle', 4.5, 'accent badge (soft variant)'],
];

/** Solid fills that carry white text — Badge variant="solid", filled buttons. */
const ON_FILL: readonly (readonly [string, number, string])[] = [
  ['brand', 4.5, 'primary button'],
  ['success', 4.5, 'Badge tone="success" variant="solid"'],
  ['warning', 4.5, 'Badge tone="warning" variant="solid"'],
  ['danger', 4.5, 'danger button / Badge tone="danger" variant="solid"'],
  ['info', 4.5, 'Badge tone="info" variant="solid"'],
  ['accent-active', 4.5, 'accent pill carrying a label'],
  ['accent-active-hover', 4.5, 'labelled accent button, hover/pressed'],
  // The accent FILL itself carries only ICONS (the add-facility FAB and the
  // nav rail's add button), so it is held to the 3:1 non-text threshold. Any
  // new accent pill with a text label must use --accent-active, which is
  // checked above at 4.5.
  ['accent', 3, 'add-facility FAB glyph (non-text, 3:1)'],
];

describe('design token contrast', () => {
  it.each(TEXT_PAIRS)('--%s on --%s is at least %f:1 (%s)', (fg, bg, min) => {
    const ratio = contrast(token(fg), token(bg));
    expect(
      ratio,
      `--${fg} (${token(fg)}) on --${bg} (${token(bg)}) is ${ratio.toFixed(2)}:1, below ${min}:1`,
    ).toBeGreaterThanOrEqual(min);
  });

  it.each(ON_FILL)('white on --%s is at least %f:1 (%s)', (fill, min) => {
    const ratio = contrast(WHITE, token(fill));
    expect(
      ratio,
      `white on --${fill} (${token(fill)}) is ${ratio.toFixed(2)}:1, below ${min}:1`,
    ).toBeGreaterThanOrEqual(min);
  });

  /**
   * White glyphs sit on the activity blaze (list dots, sport chips). A glyph
   * is a graphical object, so the bar is WCAG's 3:1, not 4.5:1.
   *
   * Historical note: the seed's `--cat-bike` (#E28C3C) measured 2.61:1 and was
   * carried as a recorded exception, because darkening it collided with the
   * old amber accent (#D5762A). The POPS rebrand moved the accent to coral,
   * the collision disappeared, and cat-bike was darkened to clear 3:1 — the
   * exception list is now EMPTY. The ratchet mechanism stays: an entry here
   * may only record a measured deficit that cannot currently be repaired, and
   * it pins the value so it can only improve.
   */
  const BLAZE_EXCEPTIONS: Readonly<Record<string, number>> = {};

  const BLAZES = [
    'cat-hike',
    'cat-run',
    'cat-bike',
    'cat-climb',
    'cat-swim',
    'cat-team',
    'cat-calisthenics',
    'cat-racket',
    'cat-precision',
    'cat-multi',
  ] as const;

  it.each(BLAZES)('white glyph on --%s is at least 3:1', (blaze) => {
    const ratio = contrast(WHITE, token(blaze));
    const known = BLAZE_EXCEPTIONS[blaze];
    if (known !== undefined) {
      // Pin the known shortfall: it may only get better, never worse.
      expect(
        ratio,
        `--${blaze} is a recorded 3:1 exception at ${known}:1; it now measures ${ratio.toFixed(2)}:1. Either repair it (and delete the exception) or update the recorded value — do not let it regress.`,
      ).toBeGreaterThanOrEqual(known);
      return;
    }
    expect(
      ratio,
      `white on --${blaze} (${token(blaze)}) is ${ratio.toFixed(2)}:1, below 3:1 — a marker glyph is a graphical object and needs 3:1`,
    ).toBeGreaterThanOrEqual(3);
  });
});

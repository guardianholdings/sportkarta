/**
 * The ONE place OG-card colours live as literal hex.
 *
 * WHY LITERALS AT ALL. `next/og` renders through satori, which resolves no CSS
 * custom properties and loads no stylesheet — a card is built from inline
 * values or it is not built. That is in direct tension with the project's rule
 * that product code consumes semantic tokens and never a raw hex.
 *
 * WHY THIS FILE IS NOT IN lib/design/. apps/web/tests/no-hardcoded-design-values.test.ts
 * scans `components/ui`, `lib/design` and `app/[locale]/design-system` and fails
 * on any hex or raw px. `lib/design/` is the obvious-looking home — it is where
 * FAMILY_COLOR and SPORT_VISUALS live — and putting the cards there would fail
 * CI on every single one. `lib/design/families.ts` stores `var(--…)` strings
 * precisely so it passes that gate; a card cannot.
 *
 * SO THE DUPLICATION IS DELIBERATE, AND HELD HONEST BY A TEST.
 * apps/web/tests/og-palette.test.ts parses app/design-tokens/colors.css and
 * asserts every constant below still equals the token it claims to mirror. The
 * source line is recorded per entry so a reader can check by eye too.
 */

/** Mirrors app/design-tokens/colors.css. Keys are the TOKEN names they track. */
export const OG_PALETTE = {
  /** --paper, colors.css:12 — the card background. */
  paper: '#FBF9F3',
  /** --surface, colors.css:14 */
  surface: '#FFFEFB',
  /** --ink, colors.css:21 — titles. */
  ink: '#1E241D',
  /** --ink-soft, colors.css:22 — subtitles. */
  inkSoft: '#3A4136',
  /** --text-muted, colors.css:23 — eyebrow and footer meta. */
  textMuted: '#7C7668',
  /** --border, colors.css:18 */
  line: '#E8E3D8',
  /** --pine-600 = --brand, colors.css:33 — the wordmark. */
  brand: '#216543',
  /** --pine-700, colors.css:34 */
  brandDeep: '#1A5036',
  /** --clay-500 = --accent, colors.css:44 */
  accent: '#D5762A',
  /** --clay-700, colors.css:46 */
  accentDeep: '#9C4E1B',
} as const;

/**
 * Which token each constant mirrors, for the drift test. Kept beside the values
 * rather than in the test so that adding a colour without registering it is a
 * visible omission in this file.
 */
export const OG_PALETTE_TOKENS: Record<keyof typeof OG_PALETTE, string> = {
  paper: 'paper',
  surface: 'surface',
  ink: 'ink',
  inkSoft: 'ink-soft',
  textMuted: 'text-muted',
  line: 'border',
  brand: 'pine-600',
  brandDeep: 'pine-700',
  accent: 'clay-500',
  accentDeep: 'clay-700',
};

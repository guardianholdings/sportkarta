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
 * apps/web/tests/og-assets.test.ts parses app/design-tokens/colors.css and
 * asserts every constant below still equals the token it claims to mirror.
 */

/** Mirrors app/design-tokens/colors.css. Keys are the TOKEN names they track. */
export const OG_PALETTE = {
  /** --paper — the card background (raw POPS paper). */
  paper: '#F5F3EE',
  /** --surface */
  surface: '#FEFDFB',
  /** --ink — titles (raw POPS ink). */
  ink: '#101418',
  /** --ink-soft — subtitles. */
  inkSoft: '#313D49',
  /** --text-muted — eyebrow and footer meta. */
  textMuted: '#646A73',
  /** --border */
  line: '#E3DFD4',
  /** --green-600 = --brand — the wordmark. */
  brand: '#0B7A40',
  /** --green-700 */
  brandDeep: '#09623A',
  /** --coral-500 = --accent — the mark's raw coral (accent rule, graphics). */
  accent: '#FF4A2B',
  /** --coral-700 — coral that may carry text. */
  accentDeep: '#B02F12',
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
  brand: 'green-600',
  brandDeep: 'green-700',
  accent: 'coral-500',
  accentDeep: 'coral-700',
};

import { POINTS_BY_EVENT } from '@sportkarta/lib/points';

/**
 * The one-shot "you just added this" banner on /obekt/[slug], driven by the
 * `?added=<points>` the dobavi server action redirects with (Stage 3.2 / the
 * A2 surfacing item in docs/ENGAGEMENT-IMPLEMENTATION.md).
 *
 * Adding a facility is the platform's LARGEST single award (10 points) and was
 * the only contribution flow that acknowledged nothing: the action redirected
 * with a bare `?added=1` and the facility page declared no `searchParams` at
 * all, so nothing could read it. Verify and condition already thanked the
 * member with the figure; this closes the gap.
 *
 * WHY A QUERY PARAMETER IS SAFE HERE. It is user-forgeable, so nothing is
 * derived from it but a congratulation — no privilege, no write, no query, no
 * points. The value is clamped to the `points_ledger` CHECK bound so a crafted
 * `?added=999999` cannot render an absurd claim, and anything that is not a
 * plain integer in range is treated as absent.
 */

/** The `points BETWEEN 1 AND 100` CHECK on points_ledger (migration 0006). */
const MIN_LEDGER_POINTS = 1;
const MAX_LEDGER_POINTS = 100;

/**
 * Parse `?added=` into a number of points to celebrate, or null for "show
 * nothing".
 *
 * Zero and absent are BOTH null, deliberately. An add that awarded nothing is a
 * real case — the ledger's idempotency key had already paid for this facility —
 * and rendering "+0" would read as a penalty for contributing. The same rule
 * the check-in success line follows: never show a zero.
 */
export function addedPoints(raw: string | string[] | undefined): number | null {
  if (typeof raw !== 'string') return null;
  // Matched as DIGITS rather than parsed with Number(), which is far looser
  // than "a plain integer": Number('0x0A') is 10, Number('1e1') is 10, and
  // Number(' 10 ') is 10. None of those can do harm here — the value is only
  // ever a congratulation — but a parser whose accepted set is wider than its
  // documented one is how a lenient reader becomes a real bug the day somebody
  // reuses it for something that matters.
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (parsed < MIN_LEDGER_POINTS || parsed > MAX_LEDGER_POINTS) return null;
  return parsed;
}

/**
 * What the action should put in the redirect: the real award, or 0 when the
 * ledger paid nothing. Read from POINTS_BY_EVENT rather than written as a
 * literal so the banner cannot drift from what was actually awarded.
 */
export function addedRedirectValue(awarded: boolean): number {
  return awarded ? POINTS_BY_EVENT.facility_added : 0;
}

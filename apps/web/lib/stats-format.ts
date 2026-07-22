// Pure, client-safe formatting for the stats UI. Percentages return null when
// the denominator is unknown/zero so the caller renders "n/a" — never
// interpolated (accuracy rule).

/** Percentage (one decimal) of part/whole, or null when whole ≤ 0. */
export function pct(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

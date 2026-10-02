/**
 * What the thanks line after a verification or a condition report says.
 *
 * Until 2026-09 it had two answers — "you earned N points" and "your
 * contribution is recorded" — and the second covered three different truths:
 * the ledger had already paid for this facility today, the member was
 * kilometres away, or the member shared no location at all. Only the first is
 * news-free. The other two are the reason the contribution will not score (and,
 * for a verification, will not publish a pin), and a member at home who is
 * never told that reasonably believes their edit went live. The actions already
 * knew the distance; this is where it reaches the member.
 *
 * Pure and client-safe on purpose: no `@sportkarta/db` import, which is why the
 * radius is not quoted in the copy (lib/contributions/proximity.ts owns it and
 * pulls in the query builder).
 */

export interface ContributionOutcome {
  /** Points this submission earned; 0 when it earned none. */
  awarded?: number;
  /** Absent when the flow never measured (a "facility is gone" report). */
  onSite?: boolean;
  /** Metres from the facility; null when no position was shared. */
  distanceM?: number | null;
}

export type ThanksMessage =
  | { key: 'thanksWithPoints'; points: number }
  | { key: 'thanksNoPoints' }
  | { key: 'offSiteNotice'; km: number }
  | { key: 'offSiteNoLocation' };

export function thanksMessage(outcome: ContributionOutcome): ThanksMessage {
  if (outcome.awarded !== undefined && outcome.awarded > 0) {
    return { key: 'thanksWithPoints', points: outcome.awarded };
  }
  if (outcome.onSite === false) {
    if (outcome.distanceM === null || outcome.distanceM === undefined) {
      return { key: 'offSiteNoLocation' };
    }
    return { key: 'offSiteNotice', km: displayKm(outcome.distanceM) };
  }
  // On site and still unpaid: the daily idempotency key had already paid. That
  // is a recorded fact, not a failure, and "+0" would read as a penalty.
  return { key: 'thanksNoPoints' };
}

/**
 * Kilometres for display: one decimal under 10 km, whole kilometres above —
 * the same rounding the map's distance labels use (lib/geo.ts formatKm). A
 * number rather than a string so the catalogue's `{km, number}` formats it in
 * the reader's locale ("0,4" in Bulgarian).
 */
export function displayKm(metres: number): number {
  const km = metres / 1000;
  return km < 10 ? Math.round(km * 10) / 10 : Math.round(km);
}

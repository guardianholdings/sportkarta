import type { PublicPassport } from '@/lib/passport';

/**
 * The passport SHARE payload (docs/ENGAGEMENT.md C4).
 *
 * A THIRD narrowing, not a reuse. The chain is:
 *
 *   OwnPassport      everything, for the owner's own page
 *     → PublicPassport   the consented public projection (`/pasport/[handle]`)
 *       → PassportShare  what may travel OFF the site, in an image or a paste
 *
 * Each step is built field by field and never by spreading the one above,
 * because spreading is precisely how `weeksAtRisk` reached the public payload in
 * phase 4 — caught only by an exact-key test.
 *
 * WHY NARROWER THAN PublicPassport AT ALL. A public passport is a page somebody
 * chose to publish and can unpublish; a share is a copy that outlives the
 * decision. `activity` — the month-by-month counts — is the clearest example: it
 * is fine on a page the member controls, and it is a behavioural history to hand
 * a group chat. So it does not travel.
 *
 * NEVER IN HERE, and each for a stated reason:
 *   - a facility, a day or a time. `publicMonthlyActivity` already "drops the
 *     place entirely" for this reason; a share must not reintroduce it.
 *   - `activity`. See above.
 *   - anything derived from the member's CURRENT behaviour, e.g. an at-risk
 *     streak: that says what a named person is doing right now.
 *   - the handle. It is in the URL the member pastes; duplicating it into the
 *     payload invites a renderer to print it as a second identifier.
 */
export interface PassportShare {
  displayName: string;
  /** Optional and often null; a city is coarse enough to travel. */
  homeCity: string | null;
  /** A MONTH, never a date — the same coarsening the public passport applies. */
  memberSince: string;
  points: number;
  contributions: number;
  checkins: number;
  /** How many badges, never which ones — a badge list is a behavioural profile. */
  badgeCount: number;
  /** Best week run ever. A durable achievement, not a live state. */
  longestWeeks: number;
}

/**
 * Project a consented public passport down to what may leave the site.
 *
 * Takes a `PublicPassport` rather than an id or a handle deliberately: the
 * consent decision (`leaderboard_eligible_members`, and the visibility predicate
 * inside `publicPassportOwner`) has already been made by the time one of these
 * exists. There is no path here that reaches the database, so there is no path
 * here that can bypass the view.
 */
export function toPassportShare(passport: PublicPassport): PassportShare {
  return {
    displayName: passport.displayName,
    homeCity: passport.homeCity,
    memberSince: passport.memberSince,
    points: passport.totals.points,
    contributions: passport.totals.contributions,
    checkins: passport.totals.checkins,
    // The COUNT, not the list.
    badgeCount: passport.badges.length,
    longestWeeks: passport.streaks.longestWeeks,
  };
}

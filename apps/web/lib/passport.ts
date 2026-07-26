import {
  markBadgesSeen,
  frozenStreakWeeks,
  passportEvents,
  passportHistory,
  passportTotals,
  publicMonthlyActivity,
  publicPassportOwner,
  recordEarnedBadges,
  sql,
  unseenBadges,
  type MonthlyActivity,
  type PassportHistoryEntry,
  type SQL,
} from '@sportkarta/db';
import {
  evaluateBadges,
  LAUNCH_BADGES,
  passportStreaks,
  type BadgeState,
  type PassportEvent,
} from '@sportkarta/lib/badges';

import { weekGrid, type WeekGrid } from '@/lib/share/week-grid';

/**
 * The sports passport (docs/ROADMAP.md §7, Stage 5.1) — assembly only. Scoring
 * is the pure engine in lib/src/badges; the queries are db/src/passport.ts.
 *
 * THE PRIVACY LINE, STATED ONCE AND ENFORCED BY TYPES. There are two
 * projections and they are different shapes on purpose:
 *
 *   OwnPassport    — names, places, timestamps. A person's own life, on a page
 *                    only they can open.
 *   PublicPassport — badges, counts and streak lengths. No facility, no
 *                    timestamp finer than a month, no history unless the member
 *                    switched it on, and even then only monthly counts.
 *
 * The reason is not squeamishness. A public page showing "checked in at Ovcha
 * Kupel, Tuesday 18:04" for a named person publishes where they reliably are
 * and when. That is a pattern-of-life disclosure — it enables somebody to be
 * found — and it is not something a member meaningfully consents to by
 * clicking "make my passport public". So the public projection never carries
 * the fields that would allow it, and buildPublicPassport is written as a
 * whitelist (it constructs its result field by field) rather than as a
 * redaction of the private one. apps/web/tests/passport-privacy.test.ts asserts
 * the resulting object against an exact key list, so a field added to the
 * private shape cannot silently appear on the public page.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * URL segment for a public passport: 24 lowercase hex chars (96 bits) from the
 * platform CSPRNG, matching the shape CHECK on the column. Random rather than
 * derived from the account id, which is the better-auth session subject and
 * must not travel in a shareable URL.
 */
export function newPublicHandle(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('hex');
}

/** `YYYY-MM` in Europe/Sofia — the finest date grain the public page may show. */
function sofiaMonth(iso: string): string {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date(iso));
  // en-CA yields YYYY-MM; normalise defensively in case ICU returns YYYY-MM-DD.
  return formatted.slice(0, 7);
}

/**
 * The four numbers, and nothing about the member's current behaviour.
 *
 * This is what a PUBLIC passport may carry. Split from the owner's view below
 * when A4 added at-risk state: "has not played yet this week" is a statement
 * about what a named person is doing right now, which is precisely what a page
 * anyone can open must not publish — and the exact-key test in
 * apps/web/tests/passport-privacy.test.ts caught it trying to.
 */
export interface PublicStreakView {
  currentDays: number;
  longestDays: number;
  currentWeeks: number;
  longestWeeks: number;
}

/** The OWNER's view: the public numbers plus their own live state. */
export interface PassportStreakView extends PublicStreakView {
  /** The week streak is alive but this week is still empty (A4). */
  weeksAtRisk: boolean;
  /**
   * How many weeks the system has forgiven, ever. Owner-only, and never
   * rendered as a balance — a freeze is applied, not spent (CLAUDE.md: the
   * economy is earning-only).
   */
  frozenWeeks: number;
}

export interface OwnPassport {
  totals: {
    points: number;
    facilitiesAdded: number;
    facilitiesVerified: number;
    conditionsReported: number;
    checkins: number;
    memberSince: string | null;
  };
  badges: BadgeState[];
  /** Slugs earned since the member last looked — the "new" marker. */
  newBadges: string[];
  streaks: PassportStreakView;
  history: PassportHistoryEntry[];
  /**
   * This Sofia week as seven cells, for the C3 plain-text share. Computed here
   * because `ownPassport` already has the event stream loaded — a separate call
   * would be a second unbounded history scan for seven booleans.
   *
   * Owner-only, like the rest of this shape. It names nobody, so every member
   * may SHARE it whatever their passport visibility (operator decision
   * 2026-07-26) — but it is still their own page that offers it.
   */
  week: WeekGrid;
  visibility: {
    isPublic: boolean;
    showActivity: boolean;
    handle: string | null;
  };
}

function streakView(
  events: readonly PassportEvent[],
  now?: Date,
  frozen?: ReadonlySet<string>,
): PassportStreakView {
  const streaks = passportStreaks(events, {
    ...(now ? { now } : {}),
    // Weeks the system forgave (A4). Passed in rather than read here so the fold
    // stays pure; an empty set is exactly the old behaviour.
    ...(frozen ? { frozen } : {}),
  });
  return {
    currentDays: streaks.days.current,
    longestDays: streaks.days.longest,
    currentWeeks: streaks.weeks.current,
    longestWeeks: streaks.weeks.longest,
    // Surfaced so the panel can say "at risk" without re-deriving a civil week
    // in a component — bucketKeyFor is the one place that may happen.
    weeksAtRisk: streaks.weeks.atRisk,
    frozenWeeks: frozen ? frozen.size : 0,
  };
}

interface VisibilityRow {
  isPublic: boolean;
  showActivity: boolean;
  handle: string | null;
}

async function readVisibility(db: SqlRunner, userId: string): Promise<VisibilityRow> {
  const result = await db.execute(sql`
    SELECT profile_visibility, public_handle, public_show_activity
    FROM users WHERE id = ${userId}
  `);
  const row = result.rows[0] ?? {};
  return {
    isPublic: row.profile_visibility === 'public',
    showActivity: row.public_show_activity === true,
    handle: row.public_handle === null || row.public_handle === undefined
      ? null
      : String(row.public_handle),
  };
}

/**
 * The member's own passport.
 *
 * Badges are evaluated from history on every read — that is the whole design
 * (lib/src/badges/rules.ts): it makes a newly-added badge appear retroactively
 * with a truthful date, and it means nothing can drift out of sync with the
 * ledger. Newly-earned ones are recorded so the "new" marker fires once.
 */
export async function ownPassport(
  db: SqlRunner,
  userId: string,
  now: Date = new Date(),
): Promise<OwnPassport> {
  const [events, totals, history, visibility, frozen] = await Promise.all([
    passportEvents(db, userId),
    passportTotals(db, userId),
    passportHistory(db, userId),
    readVisibility(db, userId),
    frozenStreakWeeks(db, userId),
  ]);

  const badges = evaluateBadges(LAUNCH_BADGES, events, { now });
  const earned = badges
    .filter((badge): badge is BadgeState & { earnedAt: Date } => badge.earnedAt !== null)
    .map((badge) => ({ slug: badge.slug, earnedAt: badge.earnedAt }));

  // Insert first, then read what is still unseen: the insert is ON CONFLICT DO
  // NOTHING, so a badge earned long ago is already recorded and does not
  // reappear as new.
  await recordEarnedBadges(db, userId, earned);
  const newBadges = await unseenBadges(db, userId);

  return {
    totals,
    badges,
    newBadges,
    streaks: streakView(events, now, frozen),
    week: weekGrid(events, now),
    history,
    visibility: {
      isPublic: visibility.isPublic,
      showActivity: visibility.showActivity,
      handle: visibility.handle,
    },
  };
}

/** Called when the member has actually seen the grid. */
export async function acknowledgeBadges(db: SqlRunner, userId: string): Promise<void> {
  await markBadgesSeen(db, userId);
}

export interface PublicBadge {
  slug: string;
  /** `YYYY-MM` — never a day or a time. */
  earnedMonth: string;
}

export interface PublicPassport {
  displayName: string;
  homeCity: string | null;
  /** `YYYY-MM`. */
  memberSince: string;
  totals: { points: number; contributions: number; checkins: number };
  /** EARNED badges only. An unearned badge's progress is activity data. */
  badges: PublicBadge[];
  streaks: PublicStreakView;
  /** Monthly counts, or null when the member has not opted into showing them. */
  activity: MonthlyActivity[] | null;
}

/**
 * A public passport by handle, or null when there is none to show.
 *
 * Null covers "no such handle" and "private" without distinguishing them: a
 * member who has gone private again must look, to somebody holding an old link,
 * exactly like a member who never existed. The visibility test itself is in the
 * SQL (db/src/passport.ts), not here.
 */
export async function publicPassport(
  db: SqlRunner,
  handle: string,
  now: Date = new Date(),
): Promise<PublicPassport | null> {
  const owner = await publicPassportOwner(db, handle);
  if (!owner) return null;

  const [events, totals, activity, frozen] = await Promise.all([
    passportEvents(db, owner.userId),
    passportTotals(db, owner.userId),
    owner.showActivity ? publicMonthlyActivity(db, owner.userId) : Promise.resolve(null),
    // The SAME freezes the owner's own view folds. Without this the two pages
    // would print different streak numbers for one person — the failure the
    // whole "one definition" discipline exists to prevent. A frozen week is not
    // itself disclosed: it only changes a number that was already public.
    frozenStreakWeeks(db, owner.userId),
  ]);

  const badges = evaluateBadges(LAUNCH_BADGES, events, { now });
  const ownerStreaks = streakView(events, now, frozen);

  // Built field by field. Nothing is spread in from a private shape, so a new
  // private field cannot arrive here by accident.
  return {
    displayName: owner.displayName,
    homeCity: owner.homeCity,
    memberSince: sofiaMonth(owner.memberSince),
    totals: {
      points: totals.points,
      contributions:
        totals.facilitiesAdded + totals.facilitiesVerified + totals.conditionsReported,
      checkins: totals.checkins,
    },
    badges: badges
      .filter((badge): badge is BadgeState & { earnedAt: Date } => badge.earnedAt !== null)
      .map((badge) => ({ slug: badge.slug, earnedMonth: sofiaMonth(badge.earnedAt.toISOString()) })),
    streaks: {
      // Field by field, deliberately: spreading the owner's view is exactly how
      // weeksAtRisk and frozenWeeks reached this payload the first time.
      currentDays: ownerStreaks.currentDays,
      longestDays: ownerStreaks.longestDays,
      currentWeeks: ownerStreaks.currentWeeks,
      longestWeeks: ownerStreaks.longestWeeks,
    },
    activity,
  };
}

export interface VisibilityUpdate {
  isPublic: boolean;
  showActivity: boolean;
}

/**
 * Set passport visibility, returning the handle a public passport is reachable
 * at (null when private).
 *
 * Going public mints a handle only if there is not one already, so a member who
 * goes private and public again keeps the link they have shared. Going private
 * KEEPS the handle rather than clearing it, for the same reason — and the read
 * path filters on visibility, so a retained handle grants nothing.
 *
 * THE MEMBER'S OWN CHOICE IS THE WHOLE AUTHORIZATION. Until migration 0020
 * this function also re-read `is_minor` from the database and refused a minor,
 * with a matching `AND is_minor = false` guard on the UPDATE. Both are gone
 * (operator decision 2026-07-25 — minors are treated as adults). Age is no
 * longer a term in the decision; nothing else was ever a term in it either,
 * which is why there is no eligibility read left to make.
 */
export async function setPassportVisibility(
  db: SqlRunner,
  userId: string,
  update: VisibilityUpdate,
): Promise<string | null> {
  const current = await readVisibility(db, userId);
  const handle = update.isPublic ? (current.handle ?? newPublicHandle()) : current.handle;

  await db.execute(sql`
    UPDATE users
    SET profile_visibility = ${update.isPublic ? 'public' : 'private'}::profile_visibility,
        public_handle = ${handle},
        public_show_activity = ${update.showActivity},
        updated_at = now()
    WHERE id = ${userId}
  `);

  return update.isPublic ? handle : null;
}

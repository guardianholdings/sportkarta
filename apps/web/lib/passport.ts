import {
  markBadgesSeen,
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

export interface PassportStreakView {
  currentDays: number;
  longestDays: number;
  currentWeeks: number;
  longestWeeks: number;
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
  visibility: {
    isPublic: boolean;
    showActivity: boolean;
    handle: string | null;
    /** Minors cannot publish; the UI explains rather than offering a broken toggle. */
    canPublish: boolean;
  };
}

function streakView(events: readonly PassportEvent[], now?: Date): PassportStreakView {
  const streaks = passportStreaks(events, now ? { now } : {});
  return {
    currentDays: streaks.days.current,
    longestDays: streaks.days.longest,
    currentWeeks: streaks.weeks.current,
    longestWeeks: streaks.weeks.longest,
  };
}

interface VisibilityRow {
  isPublic: boolean;
  showActivity: boolean;
  handle: string | null;
  isMinor: boolean;
}

async function readVisibility(db: SqlRunner, userId: string): Promise<VisibilityRow> {
  const result = await db.execute(sql`
    SELECT profile_visibility, public_handle, public_show_activity, is_minor
    FROM users WHERE id = ${userId}
  `);
  const row = result.rows[0] ?? {};
  return {
    isPublic: row.profile_visibility === 'public',
    showActivity: row.public_show_activity === true,
    handle:
      row.public_handle === null || row.public_handle === undefined
        ? null
        : String(row.public_handle),
    isMinor: row.is_minor === true,
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
  const [events, totals, history, visibility] = await Promise.all([
    passportEvents(db, userId),
    passportTotals(db, userId),
    passportHistory(db, userId),
    readVisibility(db, userId),
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
    streaks: streakView(events, now),
    history,
    visibility: {
      isPublic: visibility.isPublic,
      showActivity: visibility.showActivity,
      handle: visibility.handle,
      canPublish: !visibility.isMinor,
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
  streaks: PassportStreakView;
  /** Monthly counts, or null when the member has not opted into showing them. */
  activity: MonthlyActivity[] | null;
}

/**
 * A public passport by handle, or null when there is none to show.
 *
 * Null covers "no such handle", "private", and "belongs to a minor" without
 * distinguishing them: a member who has gone private again must look, to
 * somebody holding an old link, exactly like a member who never existed. The
 * visibility test itself is in the SQL (db/src/passport.ts), not here.
 */
export async function publicPassport(
  db: SqlRunner,
  handle: string,
  now: Date = new Date(),
): Promise<PublicPassport | null> {
  const owner = await publicPassportOwner(db, handle);
  if (!owner) return null;

  const [events, totals, activity] = await Promise.all([
    passportEvents(db, owner.userId),
    passportTotals(db, owner.userId),
    owner.showActivity ? publicMonthlyActivity(db, owner.userId) : Promise.resolve(null),
  ]);

  const badges = evaluateBadges(LAUNCH_BADGES, events, { now });

  // Built field by field. Nothing is spread in from a private shape, so a new
  // private field cannot arrive here by accident.
  return {
    displayName: owner.displayName,
    homeCity: owner.homeCity,
    memberSince: sofiaMonth(owner.memberSince),
    totals: {
      points: totals.points,
      contributions: totals.facilitiesAdded + totals.facilitiesVerified + totals.conditionsReported,
      checkins: totals.checkins,
    },
    badges: badges
      .filter((badge): badge is BadgeState & { earnedAt: Date } => badge.earnedAt !== null)
      .map((badge) => ({
        slug: badge.slug,
        earnedMonth: sofiaMonth(badge.earnedAt.toISOString()),
      })),
    streaks: streakView(events, now),
    activity,
  };
}

export class PassportVisibilityError extends Error {
  constructor(readonly code: 'minor_cannot_publish') {
    super(code);
    this.name = 'PassportVisibilityError';
  }
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
 * The minor check is re-read from the database inside this call rather than
 * taken from the session: the session cookie cache can be stale, and this is an
 * authorization decision about a child's exposure (CLAUDE.md — authorization
 * reads the role from the database, never from the session cookie cache). The
 * CHECK constraint would refuse it anyway; this exists so the member gets an
 * explanation instead of a 500.
 */
export async function setPassportVisibility(
  db: SqlRunner,
  userId: string,
  update: VisibilityUpdate,
): Promise<string | null> {
  const current = await readVisibility(db, userId);
  if (update.isPublic && current.isMinor) {
    throw new PassportVisibilityError('minor_cannot_publish');
  }

  const handle = update.isPublic ? (current.handle ?? newPublicHandle()) : current.handle;

  await db.execute(sql`
    UPDATE users
    SET profile_visibility = ${update.isPublic ? 'public' : 'private'}::profile_visibility,
        public_handle = ${handle},
        public_show_activity = ${update.showActivity},
        updated_at = now()
    WHERE id = ${userId}
      -- Belt and braces with the CHECK: a minor's row is not updated to public
      -- even if the guard above were somehow bypassed.
      AND (is_minor = false OR ${!update.isPublic})
  `);

  return update.isPublic ? handle : null;
}

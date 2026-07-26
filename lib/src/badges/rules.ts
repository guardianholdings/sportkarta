import { SOFIA_TZ } from '../recurrence/index.js';

import {
  bucketKeyFor,
  streakBuckets,
  summarizeStreak,
  type BucketKey,
  type StreakSummary,
  type StreakUnit,
} from './streaks.js';

/**
 * The declarative badge engine (docs/ROADMAP.md §7: "declarative badge engine
 * (config, not schema changes)").
 *
 * THE REQUIREMENT, RESTATED AS A CONSTRAINT: adding a badge must not touch the
 * database, this file, or any query. It is one entry in catalog.ts plus two
 * i18n keys. That rules out a badge enum, a per-badge column, a per-badge
 * query, and a grant-time hook — each of which turns "we thought of a new
 * badge" into a migration and a deploy.
 *
 * So badges are DERIVED, not granted. The database contributes exactly one
 * thing — a flat, ordered stream of PassportEvents — and every rule is a fold
 * over that stream in memory. Two consequences worth stating plainly:
 *
 *  - A badge added later is awarded RETROACTIVELY, with a truthful historical
 *    date, because the fold finds the event that would have crossed the
 *    threshold. A grant-on-write design cannot do that without a backfill
 *    script per badge, and a backfill that dates everything "today" is a lie
 *    the member can see.
 *  - Re-tuning a threshold is a config edit that immediately tells the truth
 *    about everyone, in both directions. (Raising one un-earns a badge some
 *    people hold. That is a product decision, not an engine bug — the engine
 *    reports what the rule says, and catalog.ts is where the kindness lives.)
 *
 * `user_badges` exists, but only as a NOTIFICATION ledger: it records that a
 * badge was first observed so the UI can mark it new and a later stage can
 * email about it. It is never read to decide whether a badge is held.
 *
 * ANTI-FARMING IS INHERITED, NOT REBUILT. Contribution events come from
 * points_ledger, whose idempotency keys already price one award per facility
 * added, per person per facility verified, and per person per facility per
 * Sofia day for conditions (lib/src/points.ts). A member spamming condition
 * reports on one facility therefore produces one event per day here, not a
 * hundred, without this file knowing anything about it.
 */

/**
 * Every kind of thing that can count towards a badge.
 *
 * `session_checkin` is the ATTENDANCE FACT; `session_attended` (Stage 5.4) is
 * the points_ledger row that sometimes accompanies it. One QR check-in produces
 * BOTH, so a badge rule naming both would count one evening twice. It is listed
 * here so the event stream is typed honestly rather than cast from an unknown
 * string — but participation badges count the fact, never the payment, and
 * rules.test.ts refuses any catalogue rule that reaches for `session_attended`.
 * (A check-in that hit the daily cap is still attendance; it simply did not
 * pay, and a badge for turning up should not care.)
 */
export const PASSPORT_EVENT_KINDS = [
  'facility_added',
  'facility_verified',
  'condition_reported',
  'session_checkin',
  'session_attended',
] as const;

export type PassportEventKind = (typeof PASSPORT_EVENT_KINDS)[number];

export function isPassportEventKind(value: unknown): value is PassportEventKind {
  return typeof value === 'string' && (PASSPORT_EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * One thing a member did, flattened from whichever table recorded it.
 *
 * Deliberately carries no free text and no display strings: this stream feeds a
 * scoring engine, and anything in it is one careless render away from a public
 * page. Names and labels are looked up separately, for the member's own view.
 */
export interface PassportEvent {
  kind: PassportEventKind;
  /** The instant it happened. */
  at: Date;
  /** The facility it concerns; null when the event is not about a place. */
  facilityId: string | null;
  /** Municipality of that facility, for coverage rules. */
  municipalityId: string | null;
  /** Canonical sport slugs of that facility — a multi-sport pitch has several. */
  sports: readonly string[];
  /** Points the ledger paid for it; 0 for events that are not priced. */
  points: number;
}

/** What a `distinct` rule counts one of. */
export type BadgeDimension = 'facility' | 'municipality' | 'sport' | 'day';

/**
 * The rule grammar. Deliberately a closed set of three shapes rather than a
 * predicate function or an expression language: a rule must be inspectable
 * (the UI renders "3 of 5" progress from it), serialisable, and incapable of
 * running arbitrary code from config. Everything in the launch catalogue fits.
 */
export type BadgeRule =
  | {
      kind: 'count';
      /** Which events count. Empty is refused by assertValidCatalog. */
      events: readonly PassportEventKind[];
      threshold: number;
    }
  | {
      kind: 'distinct';
      events: readonly PassportEventKind[];
      dimension: BadgeDimension;
      threshold: number;
    }
  | {
      kind: 'streak';
      events: readonly PassportEventKind[];
      unit: StreakUnit;
      threshold: number;
    };

/** Grouping in the badge grid. Presentation only — it never affects scoring. */
export type BadgeGroup = 'contribution' | 'participation';

export interface BadgeDefinition {
  /**
   * Stable identifier. Written to user_badges as TEXT, never as an enum
   * member — an enum would make a new badge a migration, which is the exact
   * thing this design exists to avoid. Renaming one orphans its notification
   * row (harmless) and its i18n keys (caught by the i18n parity test).
   */
  slug: string;
  group: BadgeGroup;
  rule: BadgeRule;
}

export interface BadgeProgress {
  /** How far along, in the rule's own units. Capped at `need`. */
  have: number;
  need: number;
}

export interface BadgeState {
  slug: string;
  group: BadgeGroup;
  earned: boolean;
  /**
   * The instant of the event that crossed the threshold — not the time of
   * evaluation. Null while unearned.
   */
  earnedAt: Date | null;
  progress: BadgeProgress;
}

export interface EvaluateOptions {
  timeZone?: string;
  /** Only used by streak rules, to answer "is it still running". */
  now?: Date;
  /**
   * Weeks the system forgave (A4). Only meaningful for streak rules.
   *
   * Threaded through to the fold so a member's DISPLAYED streak and their
   * streak BADGE cannot disagree — two different numbers for one person on one
   * page is a worse failure than either number being generous.
   */
  frozen?: ReadonlySet<BucketKey>;
}

function matches(event: PassportEvent, events: readonly PassportEventKind[]): boolean {
  return events.includes(event.kind);
}

/** Chronological, with a deterministic tie-break so equal instants never reorder. */
function ordered(events: readonly PassportEvent[]): PassportEvent[] {
  return [...events].sort((a, b) => {
    const byTime = a.at.getTime() - b.at.getTime();
    if (byTime !== 0) return byTime;
    const byKind = a.kind.localeCompare(b.kind);
    if (byKind !== 0) return byKind;
    return (a.facilityId ?? '').localeCompare(b.facilityId ?? '');
  });
}

/** The dimension values one event contributes. A multi-sport pitch yields several. */
function dimensionValues(
  event: PassportEvent,
  dimension: BadgeDimension,
  timeZone: string,
): string[] {
  switch (dimension) {
    case 'facility':
      return event.facilityId === null ? [] : [event.facilityId];
    case 'municipality':
      return event.municipalityId === null ? [] : [event.municipalityId];
    case 'sport':
      return [...new Set(event.sports)];
    case 'day':
      return [bucketKeyFor(event.at, 'day', timeZone)];
  }
}

function evaluateCount(
  rule: Extract<BadgeRule, { kind: 'count' }>,
  events: readonly PassportEvent[],
): { have: number; earnedAt: Date | null } {
  let have = 0;
  let earnedAt: Date | null = null;
  for (const event of events) {
    if (!matches(event, rule.events)) continue;
    have += 1;
    if (have === rule.threshold) earnedAt = event.at;
  }
  return { have, earnedAt };
}

function evaluateDistinct(
  rule: Extract<BadgeRule, { kind: 'distinct' }>,
  events: readonly PassportEvent[],
  timeZone: string,
): { have: number; earnedAt: Date | null } {
  const seen = new Set<string>();
  let earnedAt: Date | null = null;
  for (const event of events) {
    if (!matches(event, rule.events)) continue;
    const before = seen.size;
    for (const value of dimensionValues(event, rule.dimension, timeZone)) seen.add(value);
    // One event can cross the line by more than one (a five-sport pitch), so
    // the test is "was below, is now at or above" rather than an equality.
    if (earnedAt === null && before < rule.threshold && seen.size >= rule.threshold) {
      earnedAt = event.at;
    }
  }
  return { have: seen.size, earnedAt };
}

function evaluateStreak(
  rule: Extract<BadgeRule, { kind: 'streak' }>,
  events: readonly PassportEvent[],
  timeZone: string,
): { have: number; earnedAt: Date | null } {
  const qualifying = events.filter((event) => matches(event, rule.events));
  const buckets = streakBuckets(qualifying, rule.unit, timeZone);
  let have = 0;
  let earnedAt: Date | null = null;
  for (const bucket of buckets) {
    have = Math.max(have, bucket.runLength);
    // Earned the moment the final period is FIRST entered — a member who
    // completes a seven-day streak at 07:00 on Sunday earned it at 07:00, not
    // at the end of the day.
    if (earnedAt === null && bucket.runLength >= rule.threshold) earnedAt = bucket.firstAt;
  }
  return { have, earnedAt };
}

/** One badge against one member's stream. */
export function evaluateBadge(
  badge: BadgeDefinition,
  events: readonly PassportEvent[],
  options: EvaluateOptions = {},
): BadgeState {
  const timeZone = options.timeZone ?? SOFIA_TZ;
  const sorted = ordered(events);
  const { rule } = badge;

  const result =
    rule.kind === 'count'
      ? evaluateCount(rule, sorted)
      : rule.kind === 'distinct'
        ? evaluateDistinct(rule, sorted, timeZone)
        : evaluateStreak(rule, sorted, timeZone);

  return {
    slug: badge.slug,
    group: badge.group,
    earned: result.earnedAt !== null,
    earnedAt: result.earnedAt,
    progress: { have: Math.min(result.have, rule.threshold), need: rule.threshold },
  };
}

/** The whole catalogue, in catalogue order — the order the grid renders in. */
export function evaluateBadges(
  catalog: readonly BadgeDefinition[],
  events: readonly PassportEvent[],
  options: EvaluateOptions = {},
): BadgeState[] {
  const sorted = ordered(events);
  return catalog.map((badge) => evaluateBadge(badge, sorted, options));
}

/**
 * The streaks the passport SHOWS, as opposed to the ones badges score. Days are
 * "any activity at all"; weeks are participation, because a weekly rhythm is
 * what amateur sport actually has.
 */
export function passportStreaks(
  events: readonly PassportEvent[],
  options: EvaluateOptions = {},
): { days: StreakSummary; weeks: StreakSummary } {
  const streakOptions = {
    timeZone: options.timeZone ?? SOFIA_TZ,
    ...(options.now ? { now: options.now } : {}),
    // MUST be forwarded. Built explicitly rather than spread from `options`,
    // which is why the first version silently dropped it: the freeze reached
    // the database, the reader and this function, and then evaporated one call
    // short of the fold. Only an end-to-end read caught it.
    ...(options.frozen ? { frozen: options.frozen } : {}),
  };
  return {
    days: summarizeStreak(events, 'day', streakOptions),
    weeks: summarizeStreak(
      events.filter((event) => event.kind === 'session_checkin'),
      'week',
      streakOptions,
    ),
  };
}

/**
 * Catalogue sanity, asserted by a unit test rather than trusted.
 *
 * A badge nobody can ever earn is not a compile error and not a runtime error —
 * it is a member staring at a locked tile forever. These are the ways config
 * can be silently unreachable.
 */
export function assertValidCatalog(catalog: readonly BadgeDefinition[]): void {
  const slugs = new Set<string>();
  for (const badge of catalog) {
    // Same shape as the user_badges.badge_slug CHECK, length bound included:
    // a slug that config accepts but the database refuses would fail at the
    // INSERT, on a page load, for the member who just earned it.
    if (!/^[a-z][a-z0-9_]{2,39}$/.test(badge.slug)) {
      throw new Error(`badge slug is not a stable identifier: ${badge.slug}`);
    }
    if (slugs.has(badge.slug)) throw new Error(`duplicate badge slug: ${badge.slug}`);
    slugs.add(badge.slug);

    const { rule } = badge;
    if (rule.events.length === 0) {
      throw new Error(`badge ${badge.slug} counts no events, so it can never be earned`);
    }
    for (const kind of rule.events) {
      if (!isPassportEventKind(kind)) {
        throw new Error(`badge ${badge.slug} references unknown event kind: ${String(kind)}`);
      }
    }
    if (!Number.isInteger(rule.threshold) || rule.threshold < 1) {
      throw new Error(`badge ${badge.slug} has a threshold that is not a positive integer`);
    }
    if (rule.kind === 'streak' && rule.unit !== 'day' && rule.unit !== 'week') {
      throw new Error(`badge ${badge.slug} has an unknown streak unit`);
    }
  }
}

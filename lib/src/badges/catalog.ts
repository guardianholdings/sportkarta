import type { BadgeDefinition } from './rules.js';

/**
 * The launch badge catalogue (docs/ROADMAP.md §7, Stage 5.1) — approved by the
 * operator before implementation.
 *
 * THIS FILE IS THE WHOLE INTERFACE FOR ADDING A BADGE. One entry here plus two
 * message keys (`Badge.<slug>.name`, `Badge.<slug>.description`) in
 * apps/web/messages/bg.json and its en mirror. No migration, no query, no
 * deploy coupling — and the new badge is awarded retroactively with the real
 * date it would have been earned, because the engine folds history rather than
 * watching for new events (lib/src/badges/rules.ts).
 *
 * WHY THE THRESHOLDS ARE LOW. At launch the member population is small and the
 * facility dataset is mostly imported, so a badge calibrated for a mature
 * platform is a locked tile nobody ever opens. These are meant to be reachable
 * in the first weeks. They can be raised later — but raising one takes a badge
 * away from people who hold it, so prefer adding a higher tier to moving a
 * line somebody already crossed.
 *
 * WHAT IS DELIBERATELY ABSENT: anything comparative. No "top 10", no "more than
 * other members", no rank. Minors must never appear on individual public
 * leaderboards (CLAUDE.md), and the way to honour that is to have nothing that
 * ranks people against each other in the first place. Every badge here is a
 * threshold against a member's own history.
 */
export const LAUNCH_BADGES: readonly BadgeDefinition[] = [
  /**
   * The onboarding cliff is contribution number one. Everything else in the
   * passport is downstream of a member discovering that their edit actually
   * lands on the map.
   */
  {
    slug: 'first_contribution',
    group: 'contribution',
    rule: {
      kind: 'count',
      events: ['facility_added', 'facility_verified', 'condition_reported'],
      threshold: 1,
    },
  },
  /** Adding is the scarcest and highest-value act — the ledger prices it 10. */
  {
    slug: 'mapper_5',
    group: 'contribution',
    rule: { kind: 'count', events: ['facility_added'], threshold: 5 },
  },
  /** Verification is what makes the dataset credible in a ministry conversation. */
  {
    slug: 'verifier_10',
    group: 'contribution',
    rule: { kind: 'count', events: ['facility_verified'], threshold: 10 },
  },
  /** The repeatable habit that keeps the condition layer from going stale. */
  {
    slug: 'condition_reporter_15',
    group: 'contribution',
    rule: { kind: 'count', events: ['condition_reported'], threshold: 15 },
  },
  /**
   * Coverage outside the capital is the ranked risk in docs/ROADMAP.md §10.
   * This is the one badge pointed at it directly.
   */
  {
    slug: 'three_municipalities',
    group: 'contribution',
    rule: {
      kind: 'distinct',
      events: ['facility_added', 'facility_verified', 'condition_reported'],
      dimension: 'municipality',
      threshold: 3,
    },
  },
  /** Counters the football monoculture in both the data and the contributions. */
  {
    slug: 'five_sports',
    group: 'contribution',
    rule: {
      kind: 'distinct',
      events: ['facility_added', 'facility_verified', 'condition_reported'],
      dimension: 'sport',
      threshold: 5,
    },
  },
  /** The participation-side onboarding cliff: showing up once. */
  {
    slug: 'first_game',
    group: 'participation',
    rule: { kind: 'count', events: ['session_checkin'], threshold: 1 },
  },
  /** Retention rather than novelty — ten games is a habit, not a try. */
  {
    slug: 'regular_10',
    group: 'participation',
    rule: { kind: 'count', events: ['session_checkin'], threshold: 10 },
  },
  /**
   * Any activity, seven Sofia days running. The daily unit is why the DST work
   * in streaks.ts exists — 23 h and 25 h days must both count as one.
   */
  {
    slug: 'streak_days_7',
    group: 'participation',
    rule: {
      kind: 'streak',
      events: ['facility_added', 'facility_verified', 'condition_reported', 'session_checkin'],
      unit: 'day',
      threshold: 7,
    },
  },
  /**
   * A weekly rhythm is what amateur sport actually has. A daily play streak
   * would reward the unemployed and punish everyone with a job — this is the
   * badge a person with a Tuesday football habit can hold.
   */
  {
    slug: 'streak_weeks_4',
    group: 'participation',
    rule: { kind: 'streak', events: ['session_checkin'], unit: 'week', threshold: 4 },
  },
];

/** Slugs in catalogue order — the order the grid renders and i18n mirrors. */
export const LAUNCH_BADGE_SLUGS: readonly string[] = LAUNCH_BADGES.map((badge) => badge.slug);

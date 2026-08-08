import { addDays, SOFIA_TZ, zonedToInstant, type WallClock } from '../recurrence/index.js';

import { CampaignRuleError, type CampaignStatus } from './rules.js';

/**
 * Campaign windows, in CIVIL time (docs/ROADMAP.md §7, Stage 5.3).
 *
 * A campaign runs "1–31 August". Those are wall-clock dates on a Bulgarian
 * calendar, exactly like a session's start time (4.1) and a digest week (4.4) —
 * not instants, and emphatically not UTC dates. A campaign ending "31 August"
 * ends at midnight in Sofia; expressed as an instant that is 21:00 UTC on the
 * 31st in summer and 22:00 UTC in winter, and an implementation that stores the
 * UTC date would end some campaigns three hours early and count events from a
 * day that had not happened yet in others.
 *
 * The end date is INCLUSIVE as authored and EXCLUSIVE as compiled: "ends 31
 * August" means the window closes at 1 September 00:00 Sofia. Getting this
 * wrong is the classic off-by-one that silently discards the last day of every
 * campaign — the busiest day, since that is when people rush.
 */

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CampaignWindow {
  /** `YYYY-MM-DD`, inclusive. */
  startsOn: string;
  /** `YYYY-MM-DD`, inclusive — the last day people can still score. */
  endsOn: string;
}

/** Longest a single campaign may run. A "campaign" without an end is a feature. */
export const MAX_CAMPAIGN_DAYS = 366;

function parseCivil(value: string): WallClock {
  const match = CIVIL_DATE.exec(value.trim());
  if (!match) throw new CampaignRuleError('window_bad_date');
  const wall: WallClock = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
  };
  // Round-trip guard: rejects 2026-02-31, which Date.UTC would roll into March.
  const utc = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
  if (
    utc.getUTCFullYear() !== wall.year ||
    utc.getUTCMonth() !== wall.month - 1 ||
    utc.getUTCDate() !== wall.day
  ) {
    throw new CampaignRuleError('window_bad_date');
  }
  return wall;
}

function formatCivil(wall: WallClock): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** Whole days between two civil dates, computed civilly (never elapsed ms). */
function daysBetween(from: WallClock, to: WallClock): number {
  const a = Date.UTC(from.year, from.month - 1, from.day);
  const b = Date.UTC(to.year, to.month - 1, to.day);
  return Math.round((b - a) / 86_400_000);
}

export function validateCampaignWindow(startsOn: unknown, endsOn: unknown): CampaignWindow {
  const start = parseCivil(typeof startsOn === 'string' ? startsOn : '');
  const end = parseCivil(typeof endsOn === 'string' ? endsOn : '');
  const span = daysBetween(start, end);
  if (span < 0) throw new CampaignRuleError('window_ends_before_start');
  if (span + 1 > MAX_CAMPAIGN_DAYS) throw new CampaignRuleError('window_too_long');
  return { startsOn: formatCivil(start), endsOn: formatCivil(end) };
}

export interface WindowInstants {
  from: Date;
  /** EXCLUSIVE: midnight Sofia on the day after `endsOn`. */
  to: Date;
}

/**
 * The half-open instant range a civil window covers.
 *
 * `to` is built by adding ONE CIVIL DAY to the end date and then resolving —
 * never by adding 86 400 000 ms to an instant, which lands at 23:00 or 01:00 on
 * the two DST days and would clip or extend the final day of any campaign that
 * happens to end on the last Sunday of March or October.
 */
export function campaignWindowInstants(
  window: CampaignWindow,
  timeZone: string = SOFIA_TZ,
): WindowInstants {
  const start = parseCivil(window.startsOn);
  const endExclusive = addDays(parseCivil(window.endsOn), 1);
  return {
    from: new Date(zonedToInstant(start, timeZone).instantMs),
    to: new Date(zonedToInstant(endExclusive, timeZone).instantMs),
  };
}

/**
 * What a visitor should be shown, as opposed to what an admin set.
 *
 * `awaiting_close` is a real state and not a gap: the window has run out but
 * nobody has frozen the standings yet. Collapsing it into "closed" would show a
 * results page whose numbers still move; collapsing it into "running" would
 * invite entries after the deadline. Naming it is what lets the landing page
 * say "finished, results shortly" honestly.
 */
export type CampaignPhase =
  'draft' | 'cancelled' | 'upcoming' | 'running' | 'awaiting_close' | 'closed';

export function campaignPhase(
  status: CampaignStatus,
  window: CampaignWindow,
  now: Date = new Date(),
  timeZone: string = SOFIA_TZ,
): CampaignPhase {
  if (status === 'draft') return 'draft';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'closed') return 'closed';

  const { from, to } = campaignWindowInstants(window, timeZone);
  if (now.getTime() < from.getTime()) return 'upcoming';
  if (now.getTime() < to.getTime()) return 'running';
  return 'awaiting_close';
}

/** True while the campaign is accepting scoring events. */
export function isScoring(phase: CampaignPhase): boolean {
  return phase === 'running';
}

/** Days remaining, inclusive of today; 0 once the window has passed. */
export function daysRemaining(
  window: CampaignWindow,
  now: Date = new Date(),
  timeZone: string = SOFIA_TZ,
): number {
  const { to } = campaignWindowInstants(window, timeZone);
  if (now.getTime() >= to.getTime()) return 0;
  const start = campaignWindowInstants(window, timeZone).from;
  const effective = now.getTime() < start.getTime() ? start : now;
  // Civil day difference, not elapsed hours: on the 25-hour October day the
  // countdown must tick once, not one-and-a-bit times.
  let days = 0;
  let cursor = parseCivil(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(effective),
  );
  const endExclusive = addDays(parseCivil(window.endsOn), 1);
  while (daysBetween(cursor, endExclusive) > 0) {
    days += 1;
    cursor = addDays(cursor, 1);
  }
  return days;
}

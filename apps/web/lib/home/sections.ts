import { getDb, listCampaigns, publicFacilityVisible, sql, type CampaignRow } from '@sportkarta/db';
import { campaignPhase, daysRemaining } from '@sportkarta/lib/campaigns';
import { CANONICAL_SPORTS, type CanonicalSport } from '@sportkarta/lib/sports';

import { listUpcomingSessions, type SessionSummary } from '@/lib/sessions/occurrence';
import { getNationalStats, type NationalStats } from '@/lib/stats-data';

import { homeCached } from './memo';

/**
 * The front page's sections below the hero, each an aggregate or a list that
 * another public page already shows — this module adds no new disclosure.
 *
 * DELIBERATELY ABSENT: anybody's name. The leaderboards publish names only to
 * visitors of a NOINDEX page (/klasirane); the front page is indexed, so
 * listing the top of a board here would publish those names against a search
 * engine — the decision 0010 refused. The contribution section therefore shows
 * counts and links to the board, never rows of it.
 */

const CANONICAL = new Set<string>(CANONICAL_SPORTS);

export interface SportCount {
  sport: CanonicalSport;
  count: number;
}

/** The sports with the most free places — the hero's filter chips. */
export function heroSports(limit = 8): Promise<SportCount[]> {
  return homeCached(`sports:${limit}`, 10 * 60_000, async () => {
    const result = await getDb().execute(sql`
      SELECT s.sport, count(*)::int AS n
        FROM facilities f, LATERAL unnest(f.sport_types) AS s(sport)
       WHERE ${publicFacilityVisible} AND f.access = 'free'
       GROUP BY s.sport
       ORDER BY n DESC, s.sport
    `);
    return result.rows
      .map((row) => ({ sport: String(row.sport), count: Number(row.n) }))
      .filter((row): row is SportCount => CANONICAL.has(row.sport) && row.sport !== 'multi')
      .slice(0, limit);
  });
}

/** The same list /sesii opens with. */
export function upcomingGames(): Promise<SessionSummary[]> {
  return homeCached('games', 2 * 60_000, () => listUpcomingSessions(12));
}

export interface ContributionPulse {
  /** Awarded contributions (add, verify, condition report) in the last 30 days. */
  last30Days: number;
  /** Public facilities still waiting for somebody to confirm them. */
  awaitingVerification: number;
}

export function contributionPulse(): Promise<ContributionPulse> {
  return homeCached('contributions', 10 * 60_000, async () => {
    const result = await getDb().execute(sql`
      SELECT
        (SELECT count(*)::int FROM points_ledger
          WHERE event IN ('facility_added', 'facility_verified', 'condition_reported')
            AND created_at > now() - interval '30 days') AS last30,
        (SELECT count(*)::int FROM facilities f
          WHERE ${publicFacilityVisible} AND f.status = 'needs_verification') AS awaiting
    `);
    const row = result.rows[0] ?? {};
    return {
      last30Days: Number(row.last30 ?? 0),
      awaitingVerification: Number(row.awaiting ?? 0),
    };
  });
}

/**
 * The running campaign that ends soonest, if any — /kampanii's list, narrowed.
 * Read per request, like the clubs below: a cancelled campaign leaves the page
 * at once rather than when a memo turns over.
 */
export async function runningCampaign(): Promise<CampaignRow | null> {
  const now = new Date();
  const running = (await listCampaigns(getDb(), { statuses: ['published'] }))
    .filter((campaign) => campaignPhase(campaign.status, campaign.window, now) === 'running')
    .sort((a, b) => daysRemaining(a.window, now) - daysRemaining(b.window, now));
  return running[0] ?? null;
}

/**
 * The national figures /statistika publishes (mv_national_stats, refreshed by
 * the worker every fifteen minutes) — the hero's trust line and the numbers
 * band read them. One view read, no facilities statement of its own.
 */
export function nationalNumbers(): Promise<NationalStats | null> {
  return homeCached('national', 10 * 60_000, getNationalStats);
}

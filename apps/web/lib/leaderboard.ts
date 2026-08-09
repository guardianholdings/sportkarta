import type { LeaderboardPeriod, LeaderboardScope } from '@sportkarta/db';
import { CANONICAL_SPORTS } from '@sportkarta/lib/sports';

import { getCityBySlug, type City } from './places';

/**
 * Turning URL parameters into a leaderboard scope (docs/ROADMAP.md §7, Stage 5.2).
 *
 * Both dimensions are resolved against a CLOSED vocabulary before they reach
 * SQL — a city must exist in the municipality catalogue, a sport must be in
 * CANONICAL_SPORTS. Values are bound as parameters either way, so this is not
 * about injection; it is about not rendering a page that says "Ranking for
 * <whatever the visitor typed>", which is a reflected-content problem and an
 * invitation to index junk. An unknown value falls back to the national board
 * rather than 404ing: a stale shared link should still show a leaderboard.
 */

const CANONICAL_SPORT_SET = new Set<string>(CANONICAL_SPORTS);

export interface ResolvedScope {
  scope: LeaderboardScope;
  period: LeaderboardPeriod;
  /** Set when the scope is a city, for the heading and the link state. */
  city: City | null;
  /** Set when the scope is a sport. */
  sport: string | null;
}

export interface ScopeParams {
  grad?: string | undefined;
  sport?: string | undefined;
  period?: string | undefined;
}

export async function resolveScope(params: ScopeParams): Promise<ResolvedScope> {
  const period: LeaderboardPeriod = params.period === 'mesec' ? 'month' : 'all_time';

  // City wins when both are given: a "football in Plovdiv" board is a fourth
  // dimension nobody asked for, and quietly showing one of the two would make
  // the heading disagree with the numbers.
  if (params.grad) {
    const city = await getCityBySlug(params.grad);
    if (city) {
      return { scope: { kind: 'city', municipalityId: city.id }, period, city, sport: null };
    }
  }

  if (params.sport && CANONICAL_SPORT_SET.has(params.sport)) {
    return {
      scope: { kind: 'sport', sport: params.sport },
      period,
      city: null,
      sport: params.sport,
    };
  }

  return { scope: { kind: 'national' }, period, city: null, sport: null };
}

/** The canonical URL for a scope — used for the filter links and their active state. */
export function scopeHref(options: {
  citySlug?: string | null;
  sport?: string | null;
  period?: LeaderboardPeriod;
}): string {
  const search = new URLSearchParams();
  if (options.citySlug) search.set('grad', options.citySlug);
  else if (options.sport) search.set('sport', options.sport);
  if (options.period === 'month') search.set('period', 'mesec');
  const query = search.toString();
  return query ? `/klasirane?${query}` : '/klasirane';
}

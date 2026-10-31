/**
 * A member's engagement score, 0–100 — 1club's "engagement score", but every
 * point is explained (plan 2026-10-25: a deterministic answer, never an AI
 * black box). The same function scores the members list, the reports and the
 * owner's monthly mail, and the office prints the formula beside the number.
 *
 *   recency    0–40  40 when the last visit was ≤ 7 days ago, falling linearly
 *                    to 0 at 60 days; 0 with no visit at all.
 *   frequency  0–40  5 points per visit in the last 30 days, capped at 8 visits.
 *   tenure     0–20  2 points per full month since the first membership began,
 *                    capped at 10 months.
 *
 * Bands, for the words the office shows: ≥ 70 «висока», 40–69 «средна»,
 * < 40 «ниска».
 */

export const ENGAGEMENT_WEIGHTS = {
  recency: 40,
  frequency: 40,
  tenure: 20,
  freshDays: 7,
  staleDays: 60,
  pointsPerVisit: 5,
  pointsPerMonth: 2,
} as const;

export interface EngagementInput {
  /** Whole days since the last visit; null = never visited. */
  daysSinceLastVisit: number | null;
  visitsLast30Days: number;
  /** Whole months since the first membership started; 0 for a new member. */
  monthsAsMember: number;
}

export type EngagementBand = 'high' | 'medium' | 'low';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function engagementParts(input: EngagementInput): {
  recency: number;
  frequency: number;
  tenure: number;
} {
  const w = ENGAGEMENT_WEIGHTS;
  let recency = 0;
  if (input.daysSinceLastVisit !== null) {
    const d = Math.max(0, input.daysSinceLastVisit);
    recency =
      d <= w.freshDays
        ? w.recency
        : d >= w.staleDays
          ? 0
          : (w.recency * (w.staleDays - d)) / (w.staleDays - w.freshDays);
  }
  const frequency = clamp(Math.max(0, input.visitsLast30Days) * w.pointsPerVisit, 0, w.frequency);
  const tenure = clamp(Math.max(0, input.monthsAsMember) * w.pointsPerMonth, 0, w.tenure);
  return { recency: Math.round(recency), frequency, tenure };
}

export function engagementScore(input: EngagementInput): number {
  const parts = engagementParts(input);
  return clamp(parts.recency + parts.frequency + parts.tenure, 0, 100);
}

export function engagementBand(score: number): EngagementBand {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

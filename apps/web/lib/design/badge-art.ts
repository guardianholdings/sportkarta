/**
 * Catalogue slug → POPS badge coin (public/brand/badges/*.svg).
 *
 * The catalogue slugs are underscore_case and CHECK-pinned in the database
 * (user_badges.badge_slug), while the brand package ships hyphenated,
 * design-named files (mapper_5 is drawn as „Картограф" → cartographer.svg) —
 * so the bridge is this explicit table, never a rename on either side.
 *
 * Every coin has an earned and a `-locked` variant (same shape in grey — the
 * brand forbids blurring or padlocks). A catalogue badge with no entry here
 * simply renders without art, so adding a badge stays config-plus-two-keys
 * even before its coin is drawn.
 */
const BADGE_ART: Record<string, string> = {
  first_contribution: 'first-step',
  mapper_5: 'cartographer',
  verifier_10: 'verifier',
  condition_reporter_15: 'guardian',
  three_municipalities: 'beyond-my-city',
  five_sports: 'allrounder',
  first_game: 'first-game',
  regular_10: 'regular',
  regular_25: 'persistent',
  regular_50: 'half-century',
  regular_100: 'century',
  regular_250: 'double-half-century',
  streak_days_7: 'seven-in-a-row',
  streak_weeks_4: 'month-in-motion',
};

/** Asset path for a badge coin, or null when no art exists for the slug. */
export function badgeArt(slug: string, opts: { locked?: boolean } = {}): string | null {
  const file = BADGE_ART[slug];
  if (!file) return null;
  return `/brand/badges/${file}${opts.locked ? '-locked' : ''}.svg`;
}

/**
 * Condition vocabulary for the crowd condition layer (docs/ROADMAP.md §5).
 *
 * Slugs are English and stable; the Bulgarian labels (отлично, добро, лошо,
 * неизползваемо) live in messages/*.json like every other enum in the product,
 * so nothing here is user-visible text.
 */

/** Worst to best is meaningful: `unusable` is what closes a facility for play. */
export const CONDITION_STATES = ['excellent', 'good', 'poor', 'unusable'] as const;

export type ConditionState = (typeof CONDITION_STATES)[number];

export function isConditionState(value: unknown): value is ConditionState {
  return typeof value === 'string' && (CONDITION_STATES as readonly string[]).includes(value);
}

/**
 * Structured tags a reporter can attach. Deliberately a closed vocabulary: free
 * text would be unaggregatable across a national dataset and would invite
 * personal data into a public field.
 */
export const CANONICAL_CONDITION_TAGS = [
  'broken_equipment',
  'damaged_surface',
  'flooding',
  'litter',
  'missing_net',
  'no_lighting',
  'overgrown',
  'vandalism',
] as const;

export type ConditionTag = (typeof CANONICAL_CONDITION_TAGS)[number];

/** How many tags one report may carry — enough to be useful, not a free-for-all. */
export const MAX_CONDITION_TAGS = 6;

export function isConditionTag(value: unknown): value is ConditionTag {
  return (
    typeof value === 'string' && (CANONICAL_CONDITION_TAGS as readonly string[]).includes(value)
  );
}

/**
 * Normalise submitted tags: keep only known slugs, de-duplicate, and preserve
 * the canonical order so two equivalent reports store identical arrays.
 */
export function normalizeConditionTags(input: readonly unknown[]): ConditionTag[] {
  const selected = new Set(input.filter(isConditionTag));
  return CANONICAL_CONDITION_TAGS.filter((tag) => selected.has(tag));
}

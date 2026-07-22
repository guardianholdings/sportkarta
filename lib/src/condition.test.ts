import { describe, expect, it } from 'vitest';

import {
  CANONICAL_CONDITION_TAGS,
  CONDITION_STATES,
  isConditionState,
  isConditionTag,
  MAX_CONDITION_TAGS,
  normalizeConditionTags,
} from './condition.js';

describe('condition vocabulary', () => {
  it('is a closed, unique, sorted-by-intent set', () => {
    expect(new Set(CONDITION_STATES).size).toBe(CONDITION_STATES.length);
    expect(new Set(CANONICAL_CONDITION_TAGS).size).toBe(CANONICAL_CONDITION_TAGS.length);
    // Slugs only: labels live in messages/*.json.
    for (const value of [...CONDITION_STATES, ...CANONICAL_CONDITION_TAGS]) {
      expect(value).toMatch(/^[a-z][a-z_]*$/);
    }
    expect(MAX_CONDITION_TAGS).toBeLessThanOrEqual(CANONICAL_CONDITION_TAGS.length);
  });

  it('rejects anything outside the vocabulary', () => {
    for (const value of ['EXCELLENT', 'отлично', 'broken', '', null, 3]) {
      expect(isConditionState(value)).toBe(false);
    }
    expect(isConditionState('unusable')).toBe(true);
    expect(isConditionTag('vandalism')).toBe(true);
    expect(isConditionTag('free_text')).toBe(false);
  });
});

describe('normalizeConditionTags', () => {
  it('drops unknown values, de-duplicates and returns canonical order', () => {
    expect(normalizeConditionTags(['vandalism', 'litter', 'vandalism', 'nonsense', 42])).toEqual([
      'litter',
      'vandalism',
    ]);
  });

  it('turns an empty or hostile submission into an empty array', () => {
    expect(normalizeConditionTags([])).toEqual([]);
    expect(normalizeConditionTags(['<script>', null, undefined])).toEqual([]);
  });

  it('is idempotent', () => {
    const once = normalizeConditionTags(['no_lighting', 'litter']);
    expect(normalizeConditionTags(once)).toEqual(once);
  });
});

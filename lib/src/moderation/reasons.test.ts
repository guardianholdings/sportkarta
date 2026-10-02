import { describe, expect, it } from 'vitest';

import {
  allReasonSlugs,
  groundOf,
  isReasonFor,
  NOTICE_ACTIONED_REASONS,
  reasonsFor,
  REASONS_BY_DECISION,
} from './reasons.js';

/** The CHECK constraints in migration 0034, verbatim. */
const SLUG_SHAPE = /^[a-z][a-z0-9_]{2,39}$/;

describe('moderation reason vocabulary', () => {
  it('fits the database CHECK, so a valid choice is never refused at insert', () => {
    for (const slug of allReasonSlugs()) {
      expect(slug, slug).toMatch(SLUG_SHAPE);
    }
  });

  it('offers at least one reason for every decision that needs one', () => {
    for (const context of Object.keys(
      REASONS_BY_DECISION,
    ) as (keyof typeof REASONS_BY_DECISION)[]) {
      expect(reasonsFor(context).length).toBeGreaterThan(0);
    }
  });

  it('accepts only the reasons of the decision being taken', () => {
    expect(isReasonFor('photo_rejected', 'identifiable_person')).toBe(true);
    // A facility reason is not a photo reason, even though both are slugs.
    expect(isReasonFor('photo_rejected', 'duplicate')).toBe(false);
    expect(isReasonFor('facility_gone', 'duplicate')).toBe(true);
    expect(isReasonFor('notice_dismissed', 'not_illegal')).toBe(true);
  });

  it('refuses anything that is not an own key — no prototype tricks, no free text', () => {
    expect(isReasonFor('photo_rejected', 'toString')).toBe(false);
    expect(isReasonFor('photo_rejected', '__proto__')).toBe(false);
    expect(isReasonFor('photo_rejected', '')).toBe(false);
    expect(isReasonFor('photo_rejected', undefined)).toBe(false);
    expect(isReasonFor('photo_rejected', 'Снимката е грозна')).toBe(false);
  });

  it('names the legal ground for the reasons that claim illegality', () => {
    expect(groundOf('photo_rejected', 'illegal_content')).toBe('law');
    expect(groundOf('photo_rejected', 'identifiable_person')).toBe('terms');
    for (const slug of Object.keys(NOTICE_ACTIONED_REASONS)) {
      expect(['law', 'terms']).toContain(groundOf('notice_actioned', slug));
    }
  });

  it('never calls unknown content illegal by default', () => {
    // A slug retired after it was stored must degrade to the weaker claim.
    expect(groundOf('photo_rejected', 'retired_reason')).toBe('terms');
  });
});

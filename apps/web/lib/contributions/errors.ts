/**
 * Contribution failures the UI can explain. Every code maps to an i18n key, so
 * nothing here is user-visible text and no message ever carries user input
 * (which could otherwise reach a log).
 */
export type ContributionErrorCode =
  | 'photo_required'
  | 'invalid_photo'
  | 'photo_too_large'
  | 'name_too_long'
  | 'sports_required'
  | 'invalid_sport'
  | 'invalid_access'
  | 'invalid_surface'
  | 'invalid_coordinates'
  | 'outside_bulgaria'
  | 'duplicate_nearby'
  | 'invalid_state'
  | 'facility_not_found'
  /** You cannot verify a facility you added yourself. */
  | 'own_facility'
  | 'rate_limited';

export class ContributionError extends Error {
  constructor(
    readonly code: ContributionErrorCode,
    /** Optional slug of the facility a duplicate collides with. */
    readonly conflictSlug?: string,
  ) {
    super(code);
    this.name = 'ContributionError';
  }
}

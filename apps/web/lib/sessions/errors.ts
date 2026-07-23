/**
 * Play-layer failures the UI can explain (docs/ROADMAP.md §6). Every code maps
 * to an i18n key, so nothing here is user-visible text and no message ever
 * carries user input — which could otherwise reach a log.
 *
 * Recurrence problems keep the engine's own slugs (`rrule_*`,
 * lib/src/recurrence/rrule.ts) rather than being flattened into one
 * "invalid rule": an organiser who typed a monthly rule deserves to be told
 * that monthly is not supported, not that something went wrong.
 */
export type SessionErrorCode =
  | 'title_required'
  | 'title_too_long'
  | 'description_too_long'
  | 'invalid_sport'
  | 'invalid_skill_level'
  | 'invalid_visibility'
  | 'invalid_duration'
  | 'invalid_capacity'
  | 'invalid_start'
  | 'start_in_past'
  | 'facility_not_found'
  | 'facility_gone'
  | 'session_not_found'
  | 'occurrence_not_found'
  | 'not_organizer'
  | 'already_cancelled'
  | 'occurrence_cancelled'
  | 'occurrence_started'
  | 'not_attending'
  | 'checkin_window_closed'
  | 'invalid_checkin_method'
  /**
   * Stage 5.4. Deliberately ONE code for every way a QR token can fail —
   * forged, expired, for another session, or arriving while no secret is
   * configured. The distinctions are useful in a test and are exactly the
   * oracle an attacker wants in a response body.
   */
  | 'invalid_checkin_token'
  /**
   * The recurrence engine's own slugs, spelled out rather than written as a
   * `rrule_${string}` template: a template makes the union unenumerable, and
   * apps/web/tests/i18n.test.ts could then no longer prove that every code an
   * organiser can hit has a bg.json/en.json key.
   */
  | 'rrule_empty'
  | 'rrule_syntax'
  | 'rrule_unsupported_part'
  | 'rrule_unsupported_freq'
  | 'rrule_duplicate_part'
  | 'rrule_interval_range'
  | 'rrule_count_range'
  | 'rrule_until_invalid'
  | 'rrule_count_and_until'
  | 'rrule_byday_requires_weekly'
  | 'rrule_byday_invalid'
  | 'rrule_wkst_unsupported'
  | 'rrule_too_many_occurrences';

export class SessionError extends Error {
  constructor(readonly code: SessionErrorCode) {
    super(code);
    this.name = 'SessionError';
  }
}

/**
 * The CLOSED vocabulary of custom analytics events (ENGAGEMENT.md C1).
 *
 * WHY INSTRUMENT AT ALL. Duolingo's finding, quoted in docs/ENGAGEMENT.md §0, is
 * that you should not build share buttons — you should find the moments people
 * ALREADY screenshot and pave those. Umami had zero custom events, so there was
 * no way to know which of the six proposed share cards is worth building. These
 * events exist to answer exactly one question — which moments do members reach
 * for? — and to measure whether unburying a page (A6) actually moved anyone.
 *
 * WHY A DECLARED LIST RATHER THAN FREE STRINGS. Umami v2 autotracks any element
 * carrying `data-umami-event`, so instrumentation is a one-attribute change with
 * no import and no review surface. That convenience is the risk: the natural
 * next edit is `data-umami-event={`facility_${slug}`}`, and the event stream
 * quietly becomes a log of which member visited which playground. Every value
 * therefore has to come from this file, and
 * apps/web/tests/analytics-events.test.ts fails the build on any attribute whose
 * value is not one of these constants.
 *
 * THE RULES EVERY EVENT HERE OBEYS:
 *   1. A SURFACE and an ACTION, never a subject. No facility slug, no occurrence
 *      id, no handle, no municipality — nothing that identifies what was acted
 *      on, only that the KIND of action happened.
 *   2. No outcome that describes the anti-abuse layer's behaviour toward an
 *      individual. `checkin_submit` deliberately carries no result dimension:
 *      `unscored_out_of_range` and `unscored_daily_cap` would say "this session
 *      tried to check in from too far away" or "…has already hit today's cap",
 *      which is a behavioural record about a person, not a product metric.
 *   3. Click-tracked only. Nothing here needs `umami.track()`, so no analytics
 *      JavaScript enters the bundle and no event fires without a real click.
 *
 * These constraints are what keeps the site's published promise true — see
 * `Privacy.analyticsBody`, which describes this vocabulary in the member's own
 * words and must be updated in the same commit as any change here.
 */

export const ANALYTICS_EVENTS = {
  /**
   * The strongest "I am actually going" signal the product has, and the closest
   * thing to a conversion on the highest-traffic page. If facility pages turn
   * out to be where people act, the facility OG card (C2a) is the first to build.
   */
  facilityDirections: 'facility_directions',

  /**
   * The only share-shaped affordance that exists today: a member copying their
   * own public passport URL out of the visibility panel. This is THE number that
   * decides whether the passport share card (C4) is worth building, because it
   * measures the desire path before anything paves it.
   */
  passportPublicLink: 'passport_public_link',

  /** Contribution intent, by kind. Which of the three flows members actually finish. */
  contributionAddSubmit: 'contribution_add_submit',
  contributionVerifySubmit: 'contribution_verify_submit',
  contributionConditionSubmit: 'contribution_condition_submit',

  /** Attendance. No outcome dimension, deliberately — see rule 2 above. */
  checkinSubmit: 'checkin_submit',

  /** Joining is recruitment; leaving is churn. Both are the session invite's case (C6). */
  sessionRsvpJoin: 'session_rsvp_join',
  sessionRsvpLeave: 'session_rsvp_leave',

  /**
   * The buried-page counter. Until A6 (2026-07-26) `/sedmitsata` had no index
   * route and its only inbound link sat on `/profil`, behind requireUser() — so
   * a page built to be forwarded was reachable only by people already signed in.
   * It now has an index and a link from `/sesii`; this event is what makes
   * "unburying worked" falsifiable rather than an assertion.
   */
  weeklyOpen: 'weekly_open',

  /**
   * The C3 plain-text week. THE number ENGAGEMENT.md's C1 exists to produce:
   * the proposal ranks a pasteable text block above image cards for this
   * country, and this is the only way to find out whether that is right here.
   * Records that a share was reached for — never what was in it.
   */
  weekShare: 'week_share',
} as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

/** Every declared value, for the gate test and for exhaustiveness checks. */
export const ANALYTICS_EVENT_VALUES: readonly string[] = Object.values(ANALYTICS_EVENTS);

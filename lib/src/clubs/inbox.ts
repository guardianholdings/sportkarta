/**
 * A club's conversations, its prospects and its ratings (wave F2, 0052): the
 * closed lists that are ALSO CHECK constraints (clubs.test.ts holds them
 * equal) and the few pure rules around them. Client-safe.
 *
 * Everything here is between a club and ONE of its client records. Only
 * signed-in people write (an inquiry from a stranger creates their own record
 * first), the club reads what its own clients wrote, and nothing a member
 * wrote — a message, a comment on a class — is ever shown to anybody else.
 * The club's public page shows an AVERAGE of ratings, and only once there are
 * enough of them that no single rating can be read off it.
 */

export const THREAD_KINDS = ['message', 'inquiry'] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

/** What a visitor may ask about from the club's page (anolla's quote requests). */
export const INQUIRY_KINDS = ['rental', 'event', 'corporate', 'party', 'camp', 'other'] as const;
export type InquiryKind = (typeof INQUIRY_KINDS)[number];

export const THREAD_SUBJECT_MAX = 120;
export const THREAD_BODY_MAX = 2000;
export const INQUIRY_PARTY_MAX = 1000;
/** An inquiry's wished-for date: today or later, at most this many days ahead. */
export const INQUIRY_HORIZON_DAYS = 400;
/** One person's inquiries to one club per Sofia day. */
export const INQUIRIES_PER_DAY = 3;
/** One account's inquiries to all clubs together per Sofia day. */
export const INQUIRIES_PER_ACCOUNT_PER_DAY = 10;
/** One person's messages to one club per Sofia day, in all their threads. */
export const MEMBER_MESSAGES_PER_DAY = 30;
/** New conversations one member record may open per Sofia day. */
export const NEW_THREADS_PER_DAY = 5;

/** club_members_lead_source_known (0052). */
export const LEAD_SOURCES = [
  'inquiry',
  'trial',
  'desk',
  'phone',
  'referral',
  'social',
  'event',
  'other',
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/**
 * The sources the desk picks by hand. `inquiry` and `trial` are written by
 * the system when the person themselves asked or booked.
 */
export const LEAD_DESK_SOURCES = [
  'desk',
  'phone',
  'referral',
  'social',
  'event',
  'other',
] as const satisfies readonly LeadSource[];
export type LeadDeskSource = (typeof LEAD_DESK_SOURCES)[number];

/** club_members_lead_lost_reason_known (0052). */
export const LEAD_LOST_REASONS = [
  'price',
  'schedule',
  'location',
  'no_answer',
  'chose_other',
  'not_interested',
  'other',
] as const;
export type LeadLostReason = (typeof LEAD_LOST_REASONS)[number];

/** The stages of club_lead_stages (0052), in the order a card moves. */
export const LEAD_STAGES = ['new', 'contacted', 'trial_booked', 'visited', 'won', 'lost'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/** A new prospect nobody has called for this long is due on the staff's daily list. */
export const LEAD_FIRST_CALL_HOURS = 24;
/** Won and lost cards stay on the board this many days, then leave it. */
export const LEAD_BOARD_CLOSED_DAYS = 30;

export const FEEDBACK_COMMENT_MAX = 500;
/** A class or a booking may be rated this many days after it. */
export const FEEDBACK_WINDOW_DAYS = 14;
/** The club's page shows an average only with this many ratings … */
export const PUBLIC_RATING_MIN_COUNT = 5;
/** … within this many months. */
export const PUBLIC_RATING_MONTHS = 12;
/**
 * A request to rate goes to one member at most once in this many days.
 *
 * The club's Google review link is offered after EVERY rating, whatever the
 * stars: offering it only after good ones is review gating, which Google's
 * policy forbids and which would make a public score that only happy members
 * were asked into.
 */
export const FEEDBACK_REQUEST_SPACING_DAYS = 30;

/**
 * clubs_google_review_url_sane (0052): the three shapes Google hands a
 * business as its review link — never any page on a Google host.
 */
const GOOGLE_REVIEW_URL =
  /^https:\/\/(g\.page\/r\/[A-Za-z0-9_-]{4,120}\/review|search\.google\.com\/local\/writereview\?placeid=[A-Za-z0-9_-]{4,200}|maps\.app\.goo\.gl\/[A-Za-z0-9]{4,40})$/;

/** Whether the CHECK will admit `value` as the club's Google review link. */
export function isGoogleReviewUrl(value: string): boolean {
  return GOOGLE_REVIEW_URL.test(value);
}

/** Whether a public average may be shown for `count` ratings in the window. */
export function publicRatingVisible(count: number): boolean {
  return count >= PUBLIC_RATING_MIN_COUNT;
}

/** An average for display: one decimal. */
export function roundRating(average: number): number {
  return Math.round(average * 10) / 10;
}

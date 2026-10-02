/**
 * Why a moderation decision went against somebody (DSA Art. 17; migration 0034).
 *
 * A CLOSED VOCABULARY, like the condition tags: the reason is shown to the
 * person whose content was restricted, in their statement of reasons, and a
 * moderator's free text would be unreviewable, untranslatable and an invitation
 * to write something about the uploader rather than about the content. Slugs
 * are stable English; the labels live in messages/*.json (`ModerationReason`),
 * so the admin select, the mail and any later report all say the same words.
 *
 * Each reason also names its GROUND, because Art. 17(3)(d)-(e) wants the
 * statement to say whether the content was treated as illegal or as a breach of
 * the terms of use — two different claims, with two different ways to contest.
 *
 * The slug shape is pinned by CHECK constraints in 0034
 * (`^[a-z][a-z0-9_]{2,39}$`); `reasons.test.ts` proves every entry fits, so a
 * new reason cannot reach the database only to be refused there.
 */

export type ReasonGround = 'law' | 'terms';

interface ReasonSpec {
  ground: ReasonGround;
}

/** Why a pending photo was not published. */
export const PHOTO_REJECT_REASONS = {
  identifiable_person: { ground: 'terms' },
  not_the_facility: { ground: 'terms' },
  unusable_quality: { ground: 'terms' },
  not_uploaders_rights: { ground: 'law' },
  illegal_content: { ground: 'law' },
  other_terms: { ground: 'terms' },
} as const satisfies Record<string, ReasonSpec>;

/** Why a crowd-added facility was taken off the map (marked gone). */
export const FACILITY_GONE_REASONS = {
  does_not_exist: { ground: 'terms' },
  duplicate: { ground: 'terms' },
  not_public_facility: { ground: 'terms' },
  wrong_location: { ground: 'terms' },
  illegal_content: { ground: 'law' },
  other_terms: { ground: 'terms' },
} as const satisfies Record<string, ReasonSpec>;

/** Why a notice led to action against the reported content. */
export const NOTICE_ACTIONED_REASONS = {
  illegal_content: { ground: 'law' },
  personal_data: { ground: 'law' },
  rights_infringement: { ground: 'law' },
  terms_violation: { ground: 'terms' },
} as const satisfies Record<string, ReasonSpec>;

/** Why a notice led to no action. The ground is the terms: nothing was restricted. */
export const NOTICE_DISMISSED_REASONS = {
  not_illegal: { ground: 'terms' },
  insufficient_information: { ground: 'terms' },
  already_removed: { ground: 'terms' },
  not_hosted_here: { ground: 'terms' },
} as const satisfies Record<string, ReasonSpec>;

export type PhotoRejectReason = keyof typeof PHOTO_REJECT_REASONS;
export type FacilityGoneReason = keyof typeof FACILITY_GONE_REASONS;
export type NoticeActionedReason = keyof typeof NOTICE_ACTIONED_REASONS;
export type NoticeDismissedReason = keyof typeof NOTICE_DISMISSED_REASONS;

/** Every vocabulary, keyed by the decision it explains. */
export const REASONS_BY_DECISION = {
  photo_rejected: PHOTO_REJECT_REASONS,
  facility_gone: FACILITY_GONE_REASONS,
  notice_actioned: NOTICE_ACTIONED_REASONS,
  notice_dismissed: NOTICE_DISMISSED_REASONS,
} as const;

export type ReasonContext = keyof typeof REASONS_BY_DECISION;

/** The slugs valid for one decision, in display order. */
export function reasonsFor(context: ReasonContext): string[] {
  return Object.keys(REASONS_BY_DECISION[context]);
}

/** True when `value` is a reason this decision accepts — the server-side gate. */
export function isReasonFor(context: ReasonContext, value: unknown): value is string {
  return typeof value === 'string' && Object.hasOwn(REASONS_BY_DECISION[context], value);
}

/**
 * The ground a stored slug stands on. Unknown slugs (a reason retired from the
 * vocabulary after it was recorded) fall back to `terms`, the weaker claim —
 * a statement must never tell somebody their content was illegal by default.
 */
export function groundOf(context: ReasonContext, reason: string): ReasonGround {
  const table = REASONS_BY_DECISION[context] as Record<string, ReasonSpec>;
  return Object.hasOwn(table, reason) ? (table[reason]?.ground ?? 'terms') : 'terms';
}

/** Every slug across every vocabulary — what the i18n catalogue must label. */
export function allReasonSlugs(): string[] {
  const all = new Set<string>();
  for (const table of Object.values(REASONS_BY_DECISION)) {
    for (const slug of Object.keys(table)) all.add(slug);
  }
  return [...all].sort();
}

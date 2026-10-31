import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './auth.js';
import { businesses, facilities, municipalities, trainingLogs } from './index.js';

/**
 * The «Клубове» add-on (migrations 0039–0058; docs/ROADMAP.md Stage 9).
 *
 * THE MIGRATIONS ARE THE SOURCE OF TRUTH. They were hand-written (the snapshot
 * chain stops at 0029), and they carry what drizzle cannot express or
 * regenerate faithfully: the append-only and money guards, the local-clock and
 * booking-window triggers, the EXCLUDE on pauses, the four views, the
 * `ON DELETE SET NULL (col)` column lists, and the rrule CHECKs that drizzle-kit
 * truncates at the first `;` inside a literal (0008). This file declares the
 * columns, keys and indexes so application code gets row types, and names the
 * principal CHECKs so a reader sees the rules beside the columns. DO NOT
 * regenerate migrations from it.
 *
 * Tenancy is in the keys: every table carries `club_id`, every parent has
 * UNIQUE (club_id, id), and every intra-module foreign key is composite on
 * (club_id, parent_id) — see 0039's header for the six rules.
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const clubs = pgTable(
  'clubs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    nameBg: text('name_bg').notNull(),
    nameEn: text('name_en'),
    /** gym | studio | club | trainer | other */
    kind: text('kind').notNull().default('gym'),
    /** community | standard | pro — every tier is paid (2026-10-31, 0060) */
    tier: text('tier').notNull().default('community'),
    /** pending | active | suspended | archived */
    status: text('status').notNull().default('pending'),
    /** The owner's own switch for the public page. */
    visible: boolean('visible').notNull().default(false),
    descriptionBg: text('description_bg'),
    descriptionEn: text('description_en'),
    sports: text('sports')
      .array()
      .notNull()
      .default(sql`'{}'`),
    municipalityId: integer('municipality_id').references(() => municipalities.id, {
      onDelete: 'set null',
    }),
    legalName: text('legal_name'),
    eik: text('eik'),
    publicEmail: text('public_email'),
    publicPhone: text('public_phone'),
    websiteUrl: text('website_url'),
    locale: text('locale').notNull().default('bg'),
    timezone: text('timezone').notNull().default('Europe/Sofia'),
    currency: text('currency').notNull().default('EUR'),
    bookingOpensHours: integer('booking_opens_hours').notNull().default(168),
    cancelDeadlineHours: integer('cancel_deadline_hours').notNull().default(2),
    mailUnlinkedMembers: boolean('mail_unlinked_members').notNull().default(false),
    logoPath: text('logo_path'),
    /** green | coral | sky — one of the design system's scales (0045). */
    accent: text('accent').notNull().default('green'),
    /** The club's own terms of sale, linked before an online payment (0046). */
    termsUrl: text('terms_url'),
    memberCap: integer('member_cap'),
    /** SMS parts per Sofia month, set by the operator; 0 = no SMS (0051). */
    smsMonthlyCap: integer('sms_monthly_cap').notNull().default(0),
    /** reminder_24h | class_cancelled | booking_promoted — also sent by SMS (0051). */
    smsNotify: text('sms_notify')
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** The club's own Google review page — Google's hosts over https only (0052). */
    googleReviewUrl: text('google_review_url'),
    /** The club's own GA4 measurement id — an id, never a script (0058). */
    gaMeasurementId: text('ga_measurement_id'),
    /** The club's own Meta Pixel id (0058). */
    metaPixelId: text('meta_pixel_id'),
    /** The club's own privacy notice, linked from the consent banner; required with an id (0058). */
    privacyUrl: text('privacy_url'),
    trialEndsOn: date('trial_ends_on'),
    /** Set by hand when the operator's invoice is paid. */
    paidUntil: date('paid_until'),
    businessId: bigint('business_id', { mode: 'number' }).references(() => businesses.id, {
      onDelete: 'set null',
    }),
    appliedAt: timestamptz('applied_at').notNull().defaultNow(),
    approvedAt: timestamptz('approved_at'),
    suspendedAt: timestamptz('suspended_at'),
    archivedAt: timestamptz('archived_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('clubs_slug_unique').on(t.slug),
    index('clubs_status_idx').on(t.status),
    check(
      'clubs_slug_shape',
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(${t.slug}) BETWEEN 3 AND 60`,
    ),
    check('clubs_tier_known', sql`${t.tier} IN ('community', 'standard', 'pro')`),
    check('clubs_status_known', sql`${t.status} IN ('pending', 'active', 'suspended', 'archived')`),
    check('clubs_currency_supported', sql`${t.currency} = 'EUR'`),
  ],
);

export const clubLocations = pgTable(
  'club_locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** A map facility; deliberately no coordinates of its own. */
    facilityId: uuid('facility_id').references(() => facilities.id, { onDelete: 'set null' }),
    address: text('address'),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_locations_club_id_unique').on(t.clubId, t.id),
    uniqueIndex('club_locations_one_per_facility')
      .on(t.clubId, t.facilityId)
      .where(sql`${t.facilityId} IS NOT NULL`),
  ],
);

export const clubKioskDevices = pgTable(
  'club_kiosk_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').notNull(),
    name: text('name').notNull(),
    pairingCodeHash: text('pairing_code_hash'),
    pairingExpiresAt: timestamptz('pairing_expires_at'),
    /** SHA-256 of the tablet's cookie secret — never the secret. */
    secretHash: text('secret_hash'),
    pairedAt: timestamptz('paired_at'),
    lastSeenAt: timestamptz('last_seen_at'),
    revokedAt: timestamptz('revoked_at'),
    createdBy: text('created_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /** kiosk (a desk tablet, paired by code) | door (a controller, 0057). */
    kind: text('kind').notNull().default('kiosk'),
    /** A door's rule: member | covered (0057). NULL for a kiosk. */
    accessRule: text('access_rule'),
  },
  (t) => [
    foreignKey({
      name: 'club_kiosk_devices_location_fk',
      columns: [t.clubId, t.locationId],
      foreignColumns: [clubLocations.clubId, clubLocations.id],
    }).onDelete('cascade'),
  ],
);

export const clubStaff = pgTable(
  'club_staff',
  {
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** owner | manager | trainer | desk */
    role: text('role').notNull(),
    displayName: text('display_name'),
    bio: text('bio'),
    /** none | flat | per_head | share — report data only, no payroll. */
    payRateKind: text('pay_rate_kind').notNull().default('none'),
    payRateCents: integer('pay_rate_cents'),
    payShareBp: integer('pay_share_bp'),
    /** The trainer's own opt-in to appear on the public club page (0045). */
    publicProfile: boolean('public_profile').notNull().default(false),
    grantedBy: text('granted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'club_staff_pkey', columns: [t.clubId, t.userId] }),
    index('club_staff_user_idx').on(t.userId),
    check('club_staff_role_known', sql`${t.role} IN ('owner', 'manager', 'trainer', 'desk')`),
  ],
);

export const clubStaffInvites = pgTable('club_staff_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  clubId: uuid('club_id')
    .notNull()
    .references(() => clubs.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role').notNull(),
  tokenHash: text('token_hash').notNull().unique('club_staff_invites_token_unique'),
  expiresAt: timestamptz('expires_at').notNull(),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  acceptedAt: timestamptz('accepted_at'),
  revokedAt: timestamptz('revoked_at'),
});

/** The club's own append-only accountability log (0039). */
export const clubAudit = pgTable(
  'club_audit',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    /** By value, no FK: survives the actor's erasure. NULL for system/kiosk. */
    actorId: text('actor_id'),
    actorKind: text('actor_kind').notNull(),
    action: text('action').notNull(),
    /** By value, no FK: survives the member record's erasure. */
    subjectMemberId: uuid('subject_member_id'),
    detail: jsonb('detail').notNull().default({}),
    actedAt: timestamptz('acted_at').notNull().defaultNow(),
  },
  (t) => [
    index('club_audit_club_acted_idx').on(t.clubId, t.actedAt.desc()),
    check('club_audit_detail_small', sql`octet_length(${t.detail}::text) <= 512`),
  ],
);

export const clubMembers = pgTable(
  'club_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    /** Lowercase, NOT unique (households share an inbox). */
    email: text('email'),
    phone: text('phone'),
    /** No date of birth anywhere — a boolean the desk ticks. */
    isMinor: boolean('is_minor').notNull().default(false),
    guardianMemberId: uuid('guardian_member_id'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'`),
    staffNote: text('staff_note'),
    /** staff | import | self | api (0057) */
    source: text('source').notNull().default('staff'),
    unsubscribeToken: text('unsubscribe_token').notNull(),
    emailOptOutAt: timestamptz('email_opt_out_at'),
    /** Consent timestamps for marketing, and the SMS opt-out (0045). */
    marketingEmailAt: timestamptz('marketing_email_at'),
    marketingSmsAt: timestamptz('marketing_sms_at'),
    smsOptOutAt: timestamptz('sms_opt_out_at'),
    cardTokenHash: text('card_token_hash'),
    /**
     * The prospects pipeline (0052): only the facts a person decides; the
     * stage is derived (club_lead_stages).
     */
    leadOpenedAt: timestamptz('lead_opened_at'),
    /** inquiry | trial | desk | phone | referral | social | event | other */
    leadSource: text('lead_source'),
    leadContactedAt: timestamptz('lead_contacted_at'),
    leadNextActionOn: date('lead_next_action_on'),
    /** Staff id by value. */
    leadAssignedTo: text('lead_assigned_to'),
    leadLostAt: timestamptz('lead_lost_at'),
    /** price | schedule | location | no_answer | chose_other | not_interested | other */
    leadLostReason: text('lead_lost_reason'),
    erasureRequestedAt: timestamptz('erasure_requested_at'),
    archivedAt: timestamptz('archived_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_members_club_id_unique').on(t.clubId, t.id),
    foreignKey({
      name: 'club_members_guardian_fk',
      columns: [t.clubId, t.guardianMemberId],
      foreignColumns: [t.clubId, t.id],
    }),
    index('club_members_club_name_idx').on(t.clubId, t.displayName),
    index('club_members_leads_idx')
      .on(t.clubId, t.leadOpenedAt)
      .where(sql`${t.leadOpenedAt} IS NOT NULL`),
    check(
      'club_members_guardian_only_for_minors',
      sql`${t.guardianMemberId} IS NULL OR ${t.isMinor}`,
    ),
    check(
      'club_members_card_hash_shape',
      sql`${t.cardTokenHash} IS NULL OR ${t.cardTokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/** The ONLY users reference for a client record — CASCADE (0040). */
export const clubMemberLinks = pgTable(
  'club_member_links',
  {
    memberId: uuid('member_id').primaryKey(),
    clubId: uuid('club_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** pending | active | declined */
    status: text('status').notNull(),
    /** invite | claim | self */
    method: text('method').notNull(),
    passportConsentAt: timestamptz('passport_consent_at'),
    notifyEmail: boolean('notify_email').notNull().default(true),
    /** Mute this club's push notifications only (0051). */
    notifyPush: boolean('notify_push').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'club_member_links_member_fk',
      columns: [t.clubId, t.memberId],
      foreignColumns: [clubMembers.clubId, clubMembers.id],
    }).onDelete('cascade'),
    uniqueIndex('club_member_links_one_per_user')
      .on(t.clubId, t.userId)
      .where(sql`${t.status} <> 'declined'`),
    index('club_member_links_user_idx').on(t.userId),
  ],
);

export const clubMemberInvites = pgTable(
  'club_member_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id').notNull(),
    memberId: uuid('member_id').notNull(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique('club_member_invites_token_unique'),
    expiresAt: timestamptz('expires_at').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    acceptedAt: timestamptz('accepted_at'),
    revokedAt: timestamptz('revoked_at'),
  },
  (t) => [
    foreignKey({
      name: 'club_member_invites_member_fk',
      columns: [t.clubId, t.memberId],
      foreignColumns: [clubMembers.clubId, clubMembers.id],
    }).onDelete('cascade'),
  ],
);

export const clubPlans = pgTable(
  'club_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    nameBg: text('name_bg').notNull(),
    nameEn: text('name_en'),
    descriptionBg: text('description_bg'),
    descriptionEn: text('description_en'),
    /** unlimited | visits | trial */
    kind: text('kind').notNull(),
    /** all | adults | minors */
    audience: text('audience').notNull().default('all'),
    priceCents: integer('price_cents').notNull(),
    validityDays: integer('validity_days'),
    validityMonths: integer('validity_months'),
    visitsCount: integer('visits_count'),
    /** public | private */
    visibility: text('visibility').notNull().default('public'),
    /** The club's terms for the plan (0045). */
    autoRenew: boolean('auto_renew').notNull().default(false),
    minTermMonths: integer('min_term_months'),
    noticeDays: integer('notice_days').notNull().default(0),
    selfPauseAllowed: boolean('self_pause_allowed').notNull().default(false),
    selfCancelAllowed: boolean('self_cancel_allowed').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: timestamptz('archived_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_plans_club_id_unique').on(t.clubId, t.id),
    check('club_plans_one_validity', sql`num_nonnulls(${t.validityDays}, ${t.validityMonths}) = 1`),
  ],
);

export const clubMemberships = pgTable(
  'club_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id').notNull(),
    planId: uuid('plan_id').notNull(),
    /** Snapshot of the plan at the moment of sale. */
    planName: text('plan_name').notNull(),
    kind: text('kind').notNull(),
    audience: text('audience').notNull(),
    priceCents: integer('price_cents').notNull(),
    visitsTotal: integer('visits_total'),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    visitsUsedOffset: integer('visits_used_offset').notNull().default(0),
    cancelledAt: timestamptz('cancelled_at'),
    cancelReason: text('cancel_reason'),
    soldBy: text('sold_by'),
    /** A renewing chain (0045): the period this one follows, and its terms. */
    renews: boolean('renews').notNull().default(false),
    renewalOf: uuid('renewal_of'),
    termStartedOn: date('term_started_on'),
    renewalEndsOn: date('renewal_ends_on'),
    /** The Stripe subscription behind a renewing chain bought online (0046). */
    providerSubscriptionRef: text('provider_subscription_ref'),
    /** The plan's terms AS SOLD (0047) — never read live from the plan. */
    noticeDays: integer('notice_days').notNull().default(0),
    minTermMonths: integer('min_term_months'),
    selfPauseAllowed: boolean('self_pause_allowed').notNull().default(false),
    selfCancelAllowed: boolean('self_cancel_allowed').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_memberships_club_id_unique').on(t.clubId, t.id),
    index('club_memberships_subscription_idx')
      .on(t.providerSubscriptionRef)
      .where(sql`${t.providerSubscriptionRef} IS NOT NULL`),
    uniqueIndex('club_memberships_one_successor')
      .on(t.renewalOf)
      .where(sql`${t.renewalOf} IS NOT NULL`),
    unique('club_memberships_member_unique').on(t.clubId, t.memberId, t.id),
    foreignKey({
      name: 'club_memberships_member_fk',
      columns: [t.clubId, t.memberId],
      foreignColumns: [clubMembers.clubId, clubMembers.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'club_memberships_plan_fk',
      columns: [t.clubId, t.planId],
      foreignColumns: [clubPlans.clubId, clubPlans.id],
    }),
    uniqueIndex('club_memberships_one_trial')
      .on(t.memberId)
      .where(sql`${t.kind} = 'trial' AND ${t.cancelReason} IS DISTINCT FROM 'mistake'`),
  ],
);

export const clubMembershipPauses = pgTable(
  'club_membership_pauses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    createdBy: text('created_by'),
    /** Set in the portal by the member (0047): one per membership, no created_by. */
    byMember: boolean('by_member').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('club_membership_pauses_one_by_member')
      .on(t.membershipId)
      .where(sql`${t.byMember}`),
    foreignKey({
      name: 'club_membership_pauses_membership_fk',
      columns: [t.clubId, t.membershipId],
      foreignColumns: [clubMemberships.clubId, clubMemberships.id],
    }).onDelete('cascade'),
    // + EXCLUDE club_membership_pauses_no_overlap (btree_gist), in 0041 only.
  ],
);

export const clubCharges = pgTable(
  'club_charges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id'),
    membershipId: uuid('membership_id'),
    /** membership | drop_in | product | fee | reservation | wallet | event | other (0053) */
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    amountCents: integer('amount_cents').notNull(),
    issuedOn: date('issued_on').notNull(),
    dueOn: date('due_on').notNull(),
    voidedAt: timestamptz('voided_at'),
    createdBy: text('created_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /** The booking a no-show or late-cancel fee is for (0045). */
    bookingId: uuid('booking_id'),
  },
  (t) => [
    unique('club_charges_club_id_unique').on(t.clubId, t.id),
    uniqueIndex('club_charges_one_fee_per_booking')
      .on(t.bookingId)
      .where(sql`${t.bookingId} IS NOT NULL`),
  ],
);

/** Append-only (0041): a refund is a new negative row. */
export const clubPayments = pgTable(
  'club_payments',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    chargeId: uuid('charge_id').notNull(),
    memberId: uuid('member_id'),
    /** payment | refund */
    kind: text('kind').notNull(),
    amountCents: integer('amount_cents').notNull(),
    /** cash | card_desk | bank | card_online | wallet | other (0050) */
    method: text('method').notNull(),
    /** manual | stripe | fake (0046) */
    provider: text('provider').notNull().default('manual'),
    providerRef: text('provider_ref'),
    receivedOn: date('received_on').notNull(),
    recordedBy: text('recorded_by'),
    recordedAt: timestamptz('recorded_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'club_payments_charge_fk',
      columns: [t.clubId, t.chargeId],
      foreignColumns: [clubCharges.clubId, clubCharges.id],
    }),
    index('club_payments_charge_idx').on(t.chargeId),
  ],
);

export const clubBookingSeq = pgSequence('club_booking_seq');

export const clubClasses = pgTable(
  'club_classes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    sport: text('sport').notNull(),
    /** Composite FK to club_staff (club_id, user_id): must be this club's staff. */
    instructorUserId: text('instructor_user_id'),
    /** The room or court the class occupies; its occurrences claim it (0048). */
    resourceId: uuid('resource_id'),
    /** Wall clock, timestamp WITHOUT time zone (0008's time model). */
    startsAtLocal: timestamp('starts_at_local', { withTimezone: false }).notNull(),
    timezone: text('timezone').notNull().default('Europe/Sofia'),
    rrule: text('rrule'),
    durationMinutes: integer('duration_minutes').notNull(),
    capacity: integer('capacity'),
    bookingOpensHours: integer('booking_opens_hours').notNull().default(168),
    cancelDeadlineHours: integer('cancel_deadline_hours').notNull().default(2),
    dropInPriceCents: integer('drop_in_price_cents'),
    /** No-show and late-cancel policy (0045). */
    noShowFeeCents: integer('no_show_fee_cents'),
    lateCancelFeeCents: integer('late_cancel_fee_cents'),
    strikeLimit: integer('strike_limit'),
    strikeDays: integer('strike_days'),
    coversAllPlans: boolean('covers_all_plans').notNull().default(true),
    trialAllowed: boolean('trial_allowed').notNull().default(true),
    public: boolean('public').notNull().default(true),
    /** scheduled | cancelled */
    status: text('status').notNull().default('scheduled'),
    materializedThrough: timestamptz('materialized_through'),
    createdBy: text('created_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_classes_club_id_unique').on(t.clubId, t.id),
    foreignKey({
      name: 'club_classes_location_fk',
      columns: [t.clubId, t.locationId],
      foreignColumns: [clubLocations.clubId, clubLocations.id],
    }),
    foreignKey({
      name: 'club_classes_instructor_fk',
      columns: [t.clubId, t.instructorUserId],
      foreignColumns: [clubStaff.clubId, clubStaff.userId],
    }),
    // + the four rrule CHECKs, verbatim from 0008, in 0042 only (drizzle-kit
    //   truncates them — see the file header).
  ],
);

export const clubClassPlans = pgTable(
  'club_class_plans',
  {
    clubId: uuid('club_id').notNull(),
    classId: uuid('class_id').notNull(),
    planId: uuid('plan_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'club_class_plans_pkey', columns: [t.classId, t.planId] }),
    foreignKey({
      name: 'club_class_plans_class_fk',
      columns: [t.clubId, t.classId],
      foreignColumns: [clubClasses.clubId, clubClasses.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'club_class_plans_plan_fk',
      columns: [t.clubId, t.planId],
      foreignColumns: [clubPlans.clubId, clubPlans.id],
    }).onDelete('cascade'),
  ],
);

export const clubClassOccurrences = pgTable(
  'club_class_occurrences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id').notNull(),
    classId: uuid('class_id').notNull(),
    startsAt: timestamptz('starts_at').notNull(),
    endsAt: timestamptz('ends_at').notNull(),
    startsAtLocal: timestamp('starts_at_local', { withTimezone: false }).notNull(),
    dstResolution: text('dst_resolution').notNull().default('exact'),
    instructorUserId: text('instructor_user_id'),
    capacity: integer('capacity'),
    status: text('status').notNull().default('scheduled'),
    cancelledAt: timestamptz('cancelled_at'),
    cancellationScope: text('cancellation_scope'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_class_occurrences_club_id_unique').on(t.clubId, t.id),
    uniqueIndex('club_class_occurrences_class_start_unique').on(t.classId, t.startsAt),
    foreignKey({
      name: 'club_class_occurrences_class_fk',
      columns: [t.clubId, t.classId],
      foreignColumns: [clubClasses.clubId, clubClasses.id],
    }).onDelete('cascade'),
  ],
);

export const clubBookings = pgTable(
  'club_bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id').notNull(),
    occurrenceId: uuid('occurrence_id').notNull(),
    memberId: uuid('member_id').notNull(),
    /** Arrival ticket from club_booking_seq; position is derived. */
    seq: bigint('seq', { mode: 'number' })
      .notNull()
      .default(sql`nextval('club_booking_seq')`),
    /** active | cancelled | late_cancelled */
    state: text('state').notNull().default('active'),
    /** NULL = the member booked themselves. */
    bookedBy: text('booked_by'),
    isTrial: boolean('is_trial').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    cancelledAt: timestamptz('cancelled_at'),
    /** member | staff — who cancelled, and whether it held a place then (0047). */
    cancelKind: text('cancel_kind'),
    wasGoing: boolean('was_going'),
    /** The class's rules AS BOOKED, copied by trigger (0047). */
    noShowFeeCents: integer('no_show_fee_cents'),
    lateCancelFeeCents: integer('late_cancel_fee_cents'),
    countsStrikes: boolean('counts_strikes').notNull().default(false),
  },
  (t) => [
    unique('club_bookings_club_id_unique').on(t.clubId, t.id),
    uniqueIndex('club_bookings_occurrence_member_unique').on(t.occurrenceId, t.memberId),
    uniqueIndex('club_bookings_queue_idx')
      .on(t.occurrenceId, t.seq)
      .where(sql`${t.state} = 'active'`),
    foreignKey({
      name: 'club_bookings_occurrence_fk',
      columns: [t.clubId, t.occurrenceId],
      foreignColumns: [clubClassOccurrences.clubId, clubClassOccurrences.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'club_bookings_member_fk',
      columns: [t.clubId, t.memberId],
      foreignColumns: [clubMembers.clubId, clubMembers.id],
    }).onDelete('cascade'),
  ],
);

export const clubCheckins = pgTable(
  'club_checkins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id').notNull(),
    /** NULL = an open-gym visit. */
    occurrenceId: uuid('occurrence_id'),
    locationId: uuid('location_id').notNull(),
    /** qr_kiosk | qr_member | card | desk | api | door (0057) */
    method: text('method').notNull(),
    recordedBy: text('recorded_by'),
    consumedMembershipId: uuid('consumed_membership_id'),
    chargeId: uuid('charge_id'),
    /** The payment check's outcome — never a refusal. */
    covered: boolean('covered').notNull(),
    trainingLogId: uuid('training_log_id').references(() => trainingLogs.id, {
      onDelete: 'set null',
    }),
    sofiaDay: date('sofia_day').notNull(),
    checkedInAt: timestamptz('checked_in_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_checkins_club_id_unique').on(t.clubId, t.id),
    uniqueIndex('club_checkins_member_occurrence_unique')
      .on(t.memberId, t.occurrenceId)
      .where(sql`${t.occurrenceId} IS NOT NULL`),
    uniqueIndex('club_checkins_member_open_day_unique')
      .on(t.memberId, t.locationId, t.sofiaDay)
      .where(sql`${t.occurrenceId} IS NULL`),
  ],
);

export const clubNotifications = pgTable(
  'club_notifications',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id'),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    /** email | sms | push (0051). */
    channel: text('channel').notNull().default('email'),
    /** SMS only: the parts the gateway charges for (0051). */
    smsParts: smallint('sms_parts'),
    sentAt: timestamptz('sent_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('club_notifications_dedupe_channel_unique').on(t.clubId, t.channel, t.dedupeKey),
    check('club_notifications_one_recipient', sql`num_nonnulls(${t.memberId}, ${t.userId}) = 1`),
  ],
);

export const clubMonthlyActivity = pgTable(
  'club_monthly_activity',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    /** First day of the month. */
    month: date('month').notNull(),
    membersWithMembership: integer('members_with_membership').notNull(),
    membersWithVisits: integer('members_with_visits').notNull(),
    /** The invoice basis for paid tiers. */
    membersActive: integer('members_active').notNull(),
    checkins: integer('checkins').notNull(),
    bookings: integer('bookings').notNull(),
    revenueCents: bigint('revenue_cents', { mode: 'number' }).notNull(),
    /** SMS parts sent in the month (0051) — re-invoiced to the club. */
    smsParts: integer('sms_parts').notNull().default(0),
    computedAt: timestamptz('computed_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('club_monthly_activity_club_month_unique').on(t.clubId, t.month)],
);

/** A trainer's leave (0045); Wave C adds rooms and courts. */
export const clubTimeBlocks = pgTable(
  'club_time_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    /** Exactly one of staff_user_id / resource_id (0048: a court can be closed too). */
    staffUserId: text('staff_user_id'),
    resourceId: uuid('resource_id'),
    startsAt: timestamptz('starts_at').notNull(),
    endsAt: timestamptz('ends_at').notNull(),
    /** time_off | training | other | event — never a health reason */
    reason: text('reason').notNull(),
    /** The event that closes this resource (0053) — written by its trigger only. */
    eventId: uuid('event_id'),
    createdBy: text('created_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_time_blocks_club_id_unique').on(t.clubId, t.id),
    foreignKey({
      name: 'club_time_blocks_staff_fk',
      columns: [t.clubId, t.staffUserId],
      foreignColumns: [clubStaff.clubId, clubStaff.userId],
    }).onDelete('cascade'),
    index('club_time_blocks_staff_idx').on(t.clubId, t.staffUserId, t.startsAt),
  ],
);

/** The club's questions and answers on its public page (0045). */
export const clubFaq = pgTable(
  'club_faq',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    questionBg: text('question_bg').notNull(),
    answerBg: text('answer_bg').notNull(),
    questionEn: text('question_en'),
    answerEn: text('answer_en'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_faq_club_id_unique').on(t.clubId, t.id),
    index('club_faq_club_idx').on(t.clubId, t.sortOrder),
  ],
);

/** A club's own connected Stripe account (0046) — the account id only. */
export const clubPaymentAccounts = pgTable(
  'club_payment_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    /** stripe | fake */
    provider: text('provider').notNull(),
    accountRef: text('account_ref').notNull(),
    chargesEnabled: boolean('charges_enabled').notNull().default(false),
    /** Staff id by value (0039 rule 5). */
    connectedBy: text('connected_by'),
    connectedAt: timestamptz('connected_at').notNull().defaultNow(),
    disconnectedAt: timestamptz('disconnected_at'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_payment_accounts_club_id_unique').on(t.clubId, t.id),
    uniqueIndex('club_payment_accounts_one_live')
      .on(t.clubId)
      .where(sql`${t.disconnectedAt} IS NULL`),
    uniqueIndex('club_payment_accounts_ref_live')
      .on(t.accountRef)
      .where(sql`${t.disconnectedAt} IS NULL`),
    check('club_payment_accounts_provider_known', sql`${t.provider} IN ('stripe', 'fake')`),
    // + the guard trigger (only charges_enabled and the disconnect move), in 0046 only.
  ],
);

/** One online payment attempt (0046); applied once, by UPDATE … WHERE status = 'open'. */
export const clubCheckouts = pgTable(
  'club_checkouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    /** charge | membership | wallet (0050) */
    purpose: text('purpose').notNull(),
    memberId: uuid('member_id'),
    chargeId: uuid('charge_id'),
    planId: uuid('plan_id'),
    startsOn: date('starts_on'),
    membershipId: uuid('membership_id'),
    amountCents: integer('amount_cents').notNull(),
    /** payment | subscription */
    mode: text('mode').notNull().default('payment'),
    provider: text('provider').notNull(),
    accountRef: text('account_ref').notNull(),
    sessionRef: text('session_ref'),
    /** open | paid | expired | unapplied */
    status: text('status').notNull().default('open'),
    paymentRef: text('payment_ref'),
    subscriptionRef: text('subscription_ref'),
    /** The offer an online purchase was opened with (0049); fixed with the rest. */
    promotionId: uuid('promotion_id'),
    discountCents: integer('discount_cents'),
    /** A wallet top-up's charge label (0050), in the club's words. */
    label: text('label'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    completedAt: timestamptz('completed_at'),
  },
  (t) => [
    unique('club_checkouts_club_id_unique').on(t.clubId, t.id),
    check('club_checkouts_purpose_known', sql`${t.purpose} IN ('charge', 'membership', 'wallet')`),
    check(
      'club_checkouts_status_known',
      sql`${t.status} IN ('open', 'paid', 'expired', 'unapplied')`,
    ),
    // The member FK sets member_id NULL and the membership FK sets
    // membership_id NULL on delete (column lists drizzle cannot express);
    // declared in 0046 only, with the guard trigger.
    foreignKey({
      name: 'club_checkouts_charge_fk',
      columns: [t.clubId, t.chargeId],
      foreignColumns: [clubCharges.clubId, clubCharges.id],
    }),
    foreignKey({
      name: 'club_checkouts_plan_fk',
      columns: [t.clubId, t.planId],
      foreignColumns: [clubPlans.clubId, clubPlans.id],
    }),
    uniqueIndex('club_checkouts_session_unique')
      .on(t.sessionRef)
      .where(sql`${t.sessionRef} IS NOT NULL`),
    uniqueIndex('club_checkouts_one_open_per_charge')
      .on(t.chargeId)
      .where(sql`${t.purpose} = 'charge' AND ${t.status} = 'open'`),
    index('club_checkouts_member_idx')
      .on(t.clubId, t.memberId)
      .where(sql`${t.memberId} IS NOT NULL`),
    index('club_checkouts_charge_idx')
      .on(t.clubId, t.chargeId)
      .where(sql`${t.chargeId} IS NOT NULL`),
    index('club_checkouts_plan_idx')
      .on(t.clubId, t.planId)
      .where(sql`${t.planId} IS NOT NULL`),
    index('club_checkouts_membership_idx')
      .on(t.clubId, t.memberId, t.membershipId)
      .where(sql`${t.membershipId} IS NOT NULL`),
    index('club_checkouts_subscription_idx')
      .on(t.subscriptionRef)
      .where(sql`${t.subscriptionRef} IS NOT NULL`),
    index('club_checkouts_unapplied_idx')
      .on(t.clubId, t.completedAt)
      .where(sql`${t.status} = 'unapplied'`),
  ],
);

/** The Stripe webhook ledger (0046): ids only, never the payload; pruned after 90 days. */
export const clubPaymentEvents = pgTable(
  'club_payment_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    accountRef: text('account_ref'),
    objectRef: text('object_ref'),
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
    processedAt: timestamptz('processed_at'),
    /** applied | ignored | failed */
    outcome: text('outcome'),
  },
  (t) => [
    unique('club_payment_events_event_unique').on(t.eventId),
    index('club_payment_events_pending_idx')
      .on(t.receivedAt)
      .where(sql`${t.processedAt} IS NULL`),
    index('club_payment_events_processed_idx')
      .on(t.processedAt)
      .where(sql`${t.processedAt} IS NOT NULL`),
  ],
);

/** A bookable court, room, pitch, lane or piece of equipment (0048). */
export const clubResources = pgTable(
  'club_resources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').notNull(),
    /** court | room | pitch | lane | equipment | other */
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    /** 1 = one booking at a time; more = a pool. */
    quantity: integer('quantity').notNull().default(1),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: timestamptz('archived_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_resources_club_id_unique').on(t.clubId, t.id),
    unique('club_resources_location_unique').on(t.clubId, t.locationId, t.id),
    index('club_resources_location_idx').on(t.clubId, t.locationId, t.sortOrder),
  ],
);

/** What members book (0048): a rental of a resource, or an appointment with a trainer. */
export const clubServices = pgTable(
  'club_services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').notNull(),
    /** rental | appointment */
    kind: text('kind').notNull(),
    nameBg: text('name_bg').notNull(),
    nameEn: text('name_en'),
    descriptionBg: text('description_bg'),
    descriptionEn: text('description_en'),
    durationMin: integer('duration_min').notNull(),
    durationMax: integer('duration_max').notNull(),
    stepMinutes: integer('step_minutes').notNull().default(30),
    bufferMinutes: integer('buffer_minutes').notNull().default(0),
    /** hour | booking */
    priceUnit: text('price_unit').notNull().default('hour'),
    priceCents: integer('price_cents').notNull(),
    memberPriceCents: integer('member_price_cents'),
    bookingWindowDays: integer('booking_window_days').notNull().default(14),
    cancelDeadlineHours: integer('cancel_deadline_hours').notNull().default(24),
    /** Upcoming bookings of this service one account may hold online. */
    maxUpcomingPerMember: integer('max_upcoming_per_member').notNull().default(4),
    /** desk | online_optional | online_required */
    payment: text('payment').notNull().default('desk'),
    audience: text('audience').notNull().default('all'),
    visibility: text('visibility').notNull().default('public'),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: timestamptz('archived_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_services_club_id_unique').on(t.clubId, t.id),
    index('club_services_location_idx').on(t.clubId, t.locationId),
  ],
);

/** A booked slot (0048); its busy time lives in club_calendar_claims, by trigger. */
export const clubReservations = pgTable(
  'club_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').notNull(),
    /** SET NULL on erasure (column list in 0048 only). */
    memberId: uuid('member_id'),
    resourceId: uuid('resource_id'),
    /** Staff id by value (0039 rule 5). */
    staffUserId: text('staff_user_id'),
    startsAt: timestamptz('starts_at').notNull(),
    endsAt: timestamptz('ends_at').notNull(),
    bufferMinutes: integer('buffer_minutes').notNull().default(0),
    /** held | confirmed | cancelled | late_cancelled | expired */
    state: text('state').notNull().default('confirmed'),
    holdExpiresAt: timestamptz('hold_expires_at'),
    priceCents: integer('price_cents').notNull(),
    /** Snapshotted from the service at booking, like the price. */
    cancelDeadlineHours: integer('cancel_deadline_hours').notNull(),
    chargeId: uuid('charge_id'),
    bookedBy: text('booked_by'),
    cancelKind: text('cancel_kind'),
    cancelledAt: timestamptz('cancelled_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_reservations_club_id_unique').on(t.clubId, t.id),
    index('club_reservations_day_idx').on(t.clubId, t.startsAt),
    // + the price rules, service links, staff hours, location hours and the
    // EXCLUDE-backed club_calendar_claims, declared in 0048 only (drizzle
    // cannot express the EXCLUDE constraints or the claim triggers).
  ],
);

/** What a club sells over the counter (0049). Archived, never deleted, once sold or counted. */
export const clubProducts = pgTable(
  'club_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sku: text('sku'),
    /** drink | food | supplement | apparel | equipment | other */
    category: text('category').notNull().default('other'),
    priceCents: integer('price_cents').notNull(),
    /** 0 | 900 | 2000 (basis points) — what an invoice line carries. */
    vatRateBp: integer('vat_rate_bp').notNull().default(2000),
    trackStock: boolean('track_stock').notNull().default(true),
    lowStockAt: integer('low_stock_at'),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: timestamptz('archived_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [unique('club_products_club_id_unique').on(t.clubId, t.id)],
);

/** The stock ledger (0049), append-only by trigger; on hand = club_product_stock. */
export const clubStockMovements = pgTable(
  'club_stock_movements',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').notNull(),
    /** receive | sale | return | adjust | waste — the sign follows the kind. */
    kind: text('kind').notNull(),
    quantity: integer('quantity').notNull(),
    saleId: uuid('sale_id'),
    unitCostCents: integer('unit_cost_cents'),
    /** Staff id by value (0039 rule 5). */
    recordedBy: text('recorded_by'),
    recordedAt: timestamptz('recorded_at').notNull().defaultNow(),
  },
  (t) => [index('club_stock_movements_product_idx').on(t.clubId, t.productId)],
);

/** Gapless per-club counters (0049): `sale`, later `invoice`. */
export const clubNumberSequences = pgTable(
  'club_number_sequences',
  {
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    lastValue: bigint('last_value', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ name: 'club_number_sequences_pkey', columns: [t.clubId, t.kind] })],
);

/** One till sale (0049); a fact, only reversed (once). Not a fiscal receipt. */
export const clubSales = pgTable(
  'club_sales',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    number: bigint('number', { mode: 'number' }).notNull(),
    /** SET NULL on erasure (column list in 0049 only). */
    memberId: uuid('member_id'),
    locationId: uuid('location_id'),
    chargeId: uuid('charge_id'),
    subtotalCents: integer('subtotal_cents').notNull(),
    discountCents: integer('discount_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull(),
    /** Staff ids by value (0039 rule 5). */
    soldBy: text('sold_by').notNull(),
    soldAt: timestamptz('sold_at').notNull().defaultNow(),
    reversedAt: timestamptz('reversed_at'),
    reversedBy: text('reversed_by'),
  },
  (t) => [
    unique('club_sales_club_id_unique').on(t.clubId, t.id),
    unique('club_sales_number_unique').on(t.clubId, t.number),
    unique('club_sales_charge_unique').on(t.chargeId),
  ],
);

/** A till sale's lines as snapshots (0049); never changed. */
export const clubSaleLines = pgTable(
  'club_sale_lines',
  {
    /** Its own key to clubs, so a purge empties it in the first round (0049). */
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    saleId: uuid('sale_id').notNull(),
    lineNo: smallint('line_no').notNull(),
    productId: uuid('product_id').notNull(),
    name: text('name').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    quantity: integer('quantity').notNull(),
    discountCents: integer('discount_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull(),
    vatRateBp: integer('vat_rate_bp').notNull(),
  },
  (t) => [primaryKey({ name: 'club_sale_lines_pkey', columns: [t.saleId, t.lineNo] })],
);

/** A club offer (0049): a code, or automatic (no code). */
export const clubPromotions = pgTable(
  'club_promotions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    code: text('code'),
    /** percent (basis points) | amount (cents off) | fixed_price (cents) */
    kind: text('kind').notNull(),
    value: integer('value').notNull(),
    /** all | plans | products */
    target: text('target').notNull().default('all'),
    targetIds: uuid('target_ids').array(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on'),
    maxUses: integer('max_uses'),
    perMemberMax: integer('per_member_max'),
    newMembersOnly: boolean('new_members_only').notNull().default(false),
    minVisits90d: integer('min_visits_90d'),
    archivedAt: timestamptz('archived_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [unique('club_promotions_club_id_unique').on(t.clubId, t.id)],
);

/** Each use of an offer (0049), append-only by trigger; uses are derived. */
export const clubPromotionRedemptions = pgTable('club_promotion_redemptions', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  clubId: uuid('club_id')
    .notNull()
    .references(() => clubs.id, { onDelete: 'cascade' }),
  promotionId: uuid('promotion_id').notNull(),
  /** membership | sale */
  subject: text('subject').notNull(),
  memberId: uuid('member_id'),
  membershipId: uuid('membership_id'),
  saleId: uuid('sale_id'),
  discountCents: integer('discount_cents').notNull(),
  redeemedAt: timestamptz('redeemed_at').notNull().defaultNow(),
  // + the composite foreign keys, the SET NULL column lists and the guards,
  // declared in 0049 only.
});

export type ClubRow = typeof clubs.$inferSelect;
export type ClubLocationRow = typeof clubLocations.$inferSelect;
export type ClubStaffRow = typeof clubStaff.$inferSelect;
export type ClubMemberRow = typeof clubMembers.$inferSelect;
export type ClubMemberLinkRow = typeof clubMemberLinks.$inferSelect;
export type ClubPlanRow = typeof clubPlans.$inferSelect;
export type ClubMembershipRow = typeof clubMemberships.$inferSelect;
export type ClubChargeRow = typeof clubCharges.$inferSelect;
export type ClubPaymentRow = typeof clubPayments.$inferSelect;
export type ClubClassRow = typeof clubClasses.$inferSelect;
export type ClubClassOccurrenceRow = typeof clubClassOccurrences.$inferSelect;
export type ClubBookingRow = typeof clubBookings.$inferSelect;
export type ClubCheckinRow = typeof clubCheckins.$inferSelect;
export type ClubPaymentAccountRow = typeof clubPaymentAccounts.$inferSelect;
export type ClubCheckoutRow = typeof clubCheckouts.$inferSelect;
export type ClubResourceRow = typeof clubResources.$inferSelect;
export type ClubServiceRow = typeof clubServices.$inferSelect;
export type ClubReservationRow = typeof clubReservations.$inferSelect;

/** What an invoice prints about a club (0050) beyond clubs.legal_name and eik. */
export const clubInvoiceSettings = pgTable('club_invoice_settings', {
  clubId: uuid('club_id')
    .primaryKey()
    .references(() => clubs.id, { onDelete: 'cascade' }),
  legalAddress: text('legal_address'),
  /** BG + 9/10 digits; none: the club invoices without VAT. */
  vatNumber: text('vat_number'),
  iban: text('iban'),
  /** 0 | 900 | 2000 — the rate for what is not a product. */
  invoiceVatBp: integer('invoice_vat_bp').notNull().default(2000),
  /** The legal basis printed for a 0 % line of a VAT-registered club. */
  zeroVatBasis: text('zero_vat_basis'),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

/** Invoices and credit notes (0050): one gapless series per club; never changed. */
export const clubInvoices = pgTable(
  'club_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    /** invoice | credit_note */
    kind: text('kind').notNull(),
    number: bigint('number', { mode: 'number' }).notNull(),
    issuedOn: date('issued_on').notNull(),
    taxEventOn: date('tax_event_on').notNull(),
    /** A credit note's invoice (composite key in 0050 only). */
    correctsId: uuid('corrects_id'),
    reason: text('reason'),
    chargeId: uuid('charge_id').notNull(),
    /** SET NULL on erasure; the buyer snapshot stays (the club's legal obligation). */
    memberId: uuid('member_id'),
    supplierName: text('supplier_name').notNull(),
    supplierEik: text('supplier_eik').notNull(),
    supplierVatNumber: text('supplier_vat_number'),
    supplierAddress: text('supplier_address').notNull(),
    supplierIban: text('supplier_iban'),
    /** person | company */
    buyerKind: text('buyer_kind').notNull(),
    buyerName: text('buyer_name').notNull(),
    buyerEik: text('buyer_eik'),
    buyerVatNumber: text('buyer_vat_number'),
    buyerAddress: text('buyer_address').notNull(),
    paymentMethod: text('payment_method').notNull(),
    /** The printed basis of the document's 0 % lines (snapshot). */
    zeroVatBasis: text('zero_vat_basis'),
    baseCents: integer('base_cents').notNull(),
    vatCents: integer('vat_cents').notNull(),
    totalCents: integer('total_cents').notNull(),
    /** Staff id by value (0039 rule 5). */
    issuedBy: text('issued_by').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_invoices_club_id_unique').on(t.clubId, t.id),
    unique('club_invoices_number_unique').on(t.clubId, t.number),
  ],
);

/** An invoice's lines (0050): gross as charged, split into base and VAT. */
export const clubInvoiceLines = pgTable(
  'club_invoice_lines',
  {
    /** Its own key to clubs, so a purge empties it in the first round. */
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id').notNull(),
    lineNo: smallint('line_no').notNull(),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    discountCents: integer('discount_cents').notNull().default(0),
    /** Null when the supplier is not VAT-registered. */
    vatRateBp: integer('vat_rate_bp'),
    baseCents: integer('base_cents').notNull(),
    vatCents: integer('vat_cents').notNull(),
    totalCents: integer('total_cents').notNull(),
  },
  (t) => [primaryKey({ name: 'club_invoice_lines_pkey', columns: [t.invoiceId, t.lineNo] })],
);

/**
 * A club's message to a group (0051): fixed once scheduled, kept once sent.
 * Recipients are resolved by the worker at send time.
 */
export const clubBroadcasts = pgTable(
  'club_broadcasts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    /** service | marketing */
    purpose: text('purpose').notNull(),
    /** email | sms | push (marketing: never push) */
    channels: text('channels').array().notNull(),
    /** all | segment | filter | tag | plan | class */
    audienceKind: text('audience_kind').notNull(),
    /** The segment, filter or tag; null for all, plan and class. */
    audienceValue: text('audience_value'),
    planId: uuid('plan_id'),
    classId: uuid('class_id'),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    smsBody: text('sms_body'),
    /** draft | scheduled | sending | sent | cancelled */
    status: text('status').notNull().default('draft'),
    scheduledFor: timestamptz('scheduled_for'),
    /** Staff ids by value (0039 rule 5). */
    createdBy: text('created_by').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
    cancelledBy: text('cancelled_by'),
    cancelledAt: timestamptz('cancelled_at'),
    sentEmail: integer('sent_email'),
    sentSms: integer('sent_sms'),
    sentPush: integer('sent_push'),
  },
  (t) => [
    unique('club_broadcasts_club_id_unique').on(t.clubId, t.id),
    foreignKey({
      name: 'club_broadcasts_plan_fk',
      columns: [t.clubId, t.planId],
      foreignColumns: [clubPlans.clubId, clubPlans.id],
    }),
    foreignKey({
      name: 'club_broadcasts_class_fk',
      columns: [t.clubId, t.classId],
      foreignColumns: [clubClasses.clubId, clubClasses.id],
    }),
    index('club_broadcasts_club_idx').on(t.clubId, t.createdAt),
  ],
);

/**
 * SMS parts a club sent per Sofia month (0051) — a counter raised by a
 * trigger on every SMS claim and never lowered, so erasing a client gives no
 * parts back. Capped by clubs.sms_monthly_cap; the activity job reads it.
 */
export const clubSmsUsage = pgTable(
  'club_sms_usage',
  {
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    /** First day of the Sofia month. */
    month: date('month').notNull(),
    parts: integer('parts').notNull(),
  },
  (t) => [primaryKey({ name: 'club_sms_usage_pkey', columns: [t.clubId, t.month] })],
);

/** Messages that go by themselves (0051): one row per trigger and channel. */
export const clubAutomations = pgTable(
  'club_automations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    /** welcome | trial_follow_up | expired_follow_up | win_back | feedback_request (0052) */
    trigger: text('trigger').notNull(),
    /** email | sms */
    channel: text('channel').notNull(),
    delayDays: smallint('delay_days').notNull(),
    /** E-mail only. */
    subject: text('subject'),
    body: text('body').notNull(),
    active: boolean('active').notNull().default(true),
    /** Staff id by value. */
    updatedBy: text('updated_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_automations_club_id_unique').on(t.clubId, t.id),
    unique('club_automations_one_per_trigger').on(t.clubId, t.trigger, t.channel),
  ],
);

/**
 * A conversation between a club and one of its client records (0052): a
 * portal message, an office message to a linked member, or an inquiry from
 * the public page. Erased with the record.
 */
export const clubThreads = pgTable(
  'club_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id').notNull(),
    /** message | inquiry */
    kind: text('kind').notNull(),
    /** member | club */
    startedBy: text('started_by').notNull(),
    subject: text('subject').notNull(),
    /** rental | event | corporate | party | camp | other — inquiries only. */
    inquiryKind: text('inquiry_kind'),
    inquiryOn: date('inquiry_on'),
    partySize: smallint('party_size'),
    /** Kept by the club_thread_messages_touch trigger. */
    lastMemberAt: timestamptz('last_member_at'),
    lastClubAt: timestamptz('last_club_at'),
    memberReadAt: timestamptz('member_read_at'),
    clubReadAt: timestamptz('club_read_at'),
    closedAt: timestamptz('closed_at'),
    /** Staff id by value. */
    closedBy: text('closed_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_threads_club_id_unique').on(t.clubId, t.id),
    foreignKey({
      name: 'club_threads_member_fk',
      columns: [t.clubId, t.memberId],
      foreignColumns: [clubMembers.clubId, clubMembers.id],
    }).onDelete('cascade'),
    index('club_threads_member_idx').on(t.clubId, t.memberId),
    index('club_threads_club_idx').on(t.clubId, t.createdAt),
  ],
);

/** What was written in a thread (0052). Never edited; goes with its thread. */
export const clubThreadMessages = pgTable(
  'club_thread_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').notNull(),
    /** member | club */
    author: text('author').notNull(),
    /** Who answered for the club — staff id by value; null on the member's side. */
    staffUserId: text('staff_user_id'),
    body: text('body').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_thread_messages_club_id_unique').on(t.clubId, t.id),
    foreignKey({
      name: 'club_thread_messages_thread_fk',
      columns: [t.clubId, t.threadId],
      foreignColumns: [clubThreads.clubId, clubThreads.id],
    }).onDelete('cascade'),
    index('club_thread_messages_thread_idx').on(t.clubId, t.threadId, t.createdAt),
  ],
);

/**
 * A client's 1–5 rating of a class they came to or a past reservation of
 * theirs (0052). Only somebody who came may rate (club_feedback_attended);
 * comments are private to the club.
 */
export const clubFeedback = pgTable(
  'club_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id').notNull(),
    occurrenceId: uuid('occurrence_id'),
    reservationId: uuid('reservation_id'),
    /** The trainer of that class on that day — by value, set by the attended trigger. */
    instructorUserId: text('instructor_user_id'),
    rating: smallint('rating').notNull(),
    comment: text('comment'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_feedback_club_id_unique').on(t.clubId, t.id),
    foreignKey({
      name: 'club_feedback_member_fk',
      columns: [t.clubId, t.memberId],
      foreignColumns: [clubMembers.clubId, clubMembers.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'club_feedback_occurrence_fk',
      columns: [t.clubId, t.occurrenceId],
      foreignColumns: [clubClassOccurrences.clubId, clubClassOccurrences.id],
    }),
    foreignKey({
      name: 'club_feedback_reservation_fk',
      columns: [t.clubId, t.reservationId],
      foreignColumns: [clubReservations.clubId, clubReservations.id],
    }),
    uniqueIndex('club_feedback_occurrence_unique')
      .on(t.clubId, t.occurrenceId, t.memberId)
      .where(sql`${t.occurrenceId} IS NOT NULL`),
    uniqueIndex('club_feedback_reservation_unique')
      .on(t.clubId, t.reservationId, t.memberId)
      .where(sql`${t.reservationId} IS NOT NULL`),
    index('club_feedback_member_idx').on(t.clubId, t.memberId),
    index('club_feedback_club_idx').on(t.clubId, t.createdAt),
    check('club_feedback_rating_sane', sql`${t.rating} BETWEEN 1 AND 5`),
  ],
);

/**
 * An event, camp, workshop or tournament (0053), at one location, optionally
 * closing one resource for its span (its trigger writes the time block).
 * Cancelled, never deleted.
 */
export const clubEvents = pgTable(
  'club_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    /** event | camp | workshop | tournament */
    kind: text('kind').notNull(),
    titleBg: text('title_bg').notNull(),
    titleEn: text('title_en'),
    descriptionBg: text('description_bg'),
    descriptionEn: text('description_en'),
    sport: text('sport'),
    locationId: uuid('location_id').notNull(),
    resourceId: uuid('resource_id'),
    startsAt: timestamptz('starts_at').notNull(),
    endsAt: timestamptz('ends_at').notNull(),
    registrationOpensAt: timestamptz('registration_opens_at'),
    registrationClosesAt: timestamptz('registration_closes_at'),
    capacity: integer('capacity'),
    teamEvent: boolean('team_event').notNull().default(false),
    /** single_elimination | round_robin — set when a tournament is drawn (0054). */
    tournamentFormat: text('tournament_format'),
    /** desk | online_optional | online_required (the services' vocabulary) */
    payment: text('payment').notNull().default('desk'),
    cancelDeadlineHours: integer('cancel_deadline_hours').notNull().default(48),
    public: boolean('public').notNull().default(true),
    /** draft | published | cancelled */
    status: text('status').notNull().default('draft'),
    cancelledAt: timestamptz('cancelled_at'),
    createdBy: text('created_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_events_club_id_unique').on(t.clubId, t.id),
    foreignKey({
      name: 'club_events_location_fk',
      columns: [t.clubId, t.locationId],
      foreignColumns: [clubLocations.clubId, clubLocations.id],
    }),
    index('club_events_club_starts_idx').on(t.clubId, t.startsAt),
    // + the resource key (club_id, location_id, resource_id) and the resource
    // block trigger, declared in 0053 only.
  ],
);

/** A ticket type of an event (0053). Archived, never deleted. */
export const clubEventTickets = pgTable(
  'club_event_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull(),
    nameBg: text('name_bg').notNull(),
    nameEn: text('name_en'),
    priceCents: integer('price_cents').notNull().default(0),
    memberPriceCents: integer('member_price_cents'),
    capacity: integer('capacity'),
    /** all | adults | minors */
    audience: text('audience').notNull().default('all'),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: timestamptz('archived_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_event_tickets_club_id_unique').on(t.clubId, t.id),
    unique('club_event_tickets_event_unique').on(t.clubId, t.eventId, t.id),
    foreignKey({
      name: 'club_event_tickets_event_fk',
      columns: [t.clubId, t.eventId],
      foreignColumns: [clubEvents.clubId, clubEvents.id],
    }),
    index('club_event_tickets_event_idx').on(t.clubId, t.eventId, t.sortOrder),
  ],
);

export const clubEventRegistrationSeq = pgSequence('club_event_registration_seq');

/**
 * One place at an event (0053). Seats are counted by trigger under the event
 * row lock; the arrival ticket (seq) orders the waitlist; the price and the
 * cancel deadline are snapshotted.
 */
export const clubEventRegistrations = pgTable(
  'club_event_registrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull(),
    ticketId: uuid('ticket_id').notNull(),
    /** SET NULL on erasure (column list in 0053 only). */
    memberId: uuid('member_id'),
    seq: bigint('seq', { mode: 'number' })
      .notNull()
      .default(sql`nextval('club_event_registration_seq')`),
    /** held | confirmed | waitlisted | cancelled | late_cancelled | expired */
    state: text('state').notNull(),
    holdExpiresAt: timestamptz('hold_expires_at'),
    priceCents: integer('price_cents').notNull(),
    cancelDeadlineHours: integer('cancel_deadline_hours').notNull(),
    /** starts_at − the hours, set by the seat trigger at registration; immutable. */
    freeCancelUntil: timestamptz('free_cancel_until').notNull().defaultNow(),
    /** When the place got its seat (the seat trigger); NULL while in line. */
    seatedAt: timestamptz('seated_at'),
    chargeId: uuid('charge_id'),
    teamName: text('team_name'),
    /** Staff id by value (0039 rule 5). */
    bookedBy: text('booked_by'),
    /** member | staff | club */
    cancelKind: text('cancel_kind'),
    /** The entrant's own consent to a name in public results (0054). */
    namePublicAt: timestamptz('name_public_at'),
    cancelledAt: timestamptz('cancelled_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_event_registrations_club_id_unique').on(t.clubId, t.id),
    unique('club_event_registrations_seq_unique').on(t.seq),
    foreignKey({
      name: 'club_event_registrations_event_fk',
      columns: [t.clubId, t.eventId],
      foreignColumns: [clubEvents.clubId, clubEvents.id],
    }),
    foreignKey({
      name: 'club_event_registrations_ticket_fk',
      columns: [t.clubId, t.eventId, t.ticketId],
      foreignColumns: [clubEventTickets.clubId, clubEventTickets.eventId, clubEventTickets.id],
    }),
    foreignKey({
      name: 'club_event_registrations_charge_fk',
      columns: [t.clubId, t.chargeId],
      foreignColumns: [clubCharges.clubId, clubCharges.id],
    }),
    index('club_event_registrations_event_idx').on(t.clubId, t.eventId, t.seq),
    uniqueIndex('club_event_registrations_charge_unique')
      .on(t.clubId, t.chargeId)
      .where(sql`${t.chargeId} IS NOT NULL`),
    uniqueIndex('club_event_registrations_one_live')
      .on(t.clubId, t.eventId, t.memberId)
      .where(sql`${t.memberId} IS NOT NULL AND ${t.state} IN ('held', 'confirmed', 'waitlisted')`),
    // + the member key (SET NULL on one column), the seat and guard triggers,
    // the confirm-hold trigger on club_payments and club_charge_holds, in 0053.
  ],
);

/**
 * One match of a drawn tournament (0054): entrants are places of the same
 * event; the result's shape is CHECK-pinned to its status. Standings and
 * ratings are derived from these rows (lib/src/clubs/tournament.ts).
 */
export const clubTournamentMatches = pgTable(
  'club_tournament_matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull(),
    round: smallint('round').notNull(),
    slot: smallint('slot').notNull(),
    entrantA: uuid('entrant_a'),
    entrantB: uuid('entrant_b'),
    scoreA: integer('score_a'),
    scoreB: integer('score_b'),
    winner: uuid('winner'),
    /** pending | played | walkover | bye */
    status: text('status').notNull().default('pending'),
    /** Staff id by value (0039 rule 5). */
    recordedBy: text('recorded_by'),
    recordedAt: timestamptz('recorded_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_tournament_matches_club_id_unique').on(t.clubId, t.id),
    unique('club_tournament_matches_position_unique').on(t.clubId, t.eventId, t.round, t.slot),
    foreignKey({
      name: 'club_tournament_matches_event_fk',
      columns: [t.clubId, t.eventId],
      foreignColumns: [clubEvents.clubId, clubEvents.id],
    }),
    // + the three entrant / winner keys to (club_id, event_id, registration),
    // the result-shape CHECKs and the guard (results kept, format kept, an
    // elimination never drawn), declared in 0054 only.
  ],
);

/**
 * A club document — waiver, rules, consent (0055): who must sign it. Its text
 * lives in club_document_versions.
 */
export const clubDocuments = pgTable(
  'club_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    /** waiver | rules | consent | other */
    kind: text('kind').notNull(),
    titleBg: text('title_bg').notNull(),
    titleEn: text('title_en'),
    /** none | all | minors | trial */
    requiredFor: text('required_for').notNull().default('none'),
    archivedAt: timestamptz('archived_at'),
    /** Staff id by value (0039 rule 5). */
    createdBy: text('created_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [unique('club_documents_club_id_unique').on(t.clubId, t.id)],
);

/**
 * One version of a document's title and text (0055) — append-only; the
 * number, the hash and the time are stamped by the database, which also
 * makes this title the document's current one.
 */
export const clubDocumentVersions = pgTable(
  'club_document_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').notNull(),
    version: integer('version').notNull(),
    titleBg: text('title_bg').notNull(),
    titleEn: text('title_en'),
    bodyBg: text('body_bg').notNull(),
    bodyEn: text('body_en'),
    requiresResign: boolean('requires_resign').notNull().default(true),
    bodySha256: text('body_sha256').notNull(),
    /** Staff id by value (0039 rule 5). */
    publishedBy: text('published_by'),
    publishedAt: timestamptz('published_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_document_versions_club_id_unique').on(t.clubId, t.id),
    unique('club_document_versions_document_unique').on(t.clubId, t.documentId, t.id),
    unique('club_document_versions_number_unique').on(t.clubId, t.documentId, t.version),
    foreignKey({
      name: 'club_document_versions_document_fk',
      columns: [t.clubId, t.documentId],
      foreignColumns: [clubDocuments.clubId, clubDocuments.id],
    }),
  ],
);

/**
 * A client's signature of one version (0055). Never edited; goes with the
 * client's record (CASCADE) or the club.
 */
export const clubDocumentSignatures = pgTable(
  'club_document_signatures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').notNull(),
    versionId: uuid('version_id').notNull(),
    memberId: uuid('member_id').notNull(),
    /** self | guardian */
    signerKind: text('signer_kind').notNull(),
    signerName: text('signer_name').notNull(),
    /** portal | desk */
    method: text('method').notNull(),
    /** The witnessing member of staff at the desk — by value (0039 rule 5). */
    witnessedBy: text('witnessed_by'),
    bodySha256: text('body_sha256').notNull(),
    signedAt: timestamptz('signed_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_document_signatures_club_id_unique').on(t.clubId, t.id),
    index('club_document_signatures_member_idx').on(t.clubId, t.memberId, t.documentId),
    index('club_document_signatures_document_idx').on(t.clubId, t.documentId, t.signedAt),
    uniqueIndex('club_document_signatures_once').on(
      t.clubId,
      t.documentId,
      t.versionId,
      t.memberId,
    ),
    foreignKey({
      name: 'club_document_signatures_version_fk',
      columns: [t.clubId, t.documentId, t.versionId],
      foreignColumns: [
        clubDocumentVersions.clubId,
        clubDocumentVersions.documentId,
        clubDocumentVersions.id,
      ],
    }),
    foreignKey({
      name: 'club_document_signatures_member_fk',
      columns: [t.clubId, t.memberId],
      foreignColumns: [clubMembers.clubId, clubMembers.id],
    }).onDelete('cascade'),
    // + the CHECKs, the stamp and the never-edited guard, and the derived
    // view club_documents_missing, declared in 0055 only.
  ],
);

/**
 * A club's grading ladder (0056): the sport whose classes count toward it
 * (NULL — every check-in). Its ranks live in club_ranks.
 */
export const clubRankLadders = pgTable(
  'club_rank_ladders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    nameBg: text('name_bg').notNull(),
    nameEn: text('name_en'),
    sport: text('sport'),
    archivedAt: timestamptz('archived_at'),
    /** Staff id by value (0039 rule 5). */
    createdBy: text('created_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [unique('club_rank_ladders_club_id_unique').on(t.clubId, t.id)],
);

/**
 * One rank of a ladder (0056): its place is numbered by the database; its
 * colours come from the closed belt palette; what it asks before it is
 * awarded (check-ins and/or months at the rank before).
 */
export const clubRanks = pgTable(
  'club_ranks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    ladderId: uuid('ladder_id').notNull(),
    position: integer('position').notNull(),
    nameBg: text('name_bg').notNull(),
    nameEn: text('name_en'),
    /** BELT_COLOURS */
    colour: text('colour').notNull(),
    accent: text('accent'),
    stripes: smallint('stripes').notNull().default(0),
    minAttendances: integer('min_attendances'),
    minMonths: integer('min_months'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_ranks_club_id_unique').on(t.clubId, t.id),
    unique('club_ranks_ladder_unique').on(t.clubId, t.ladderId, t.id),
    foreignKey({
      name: 'club_ranks_ladder_fk',
      columns: [t.clubId, t.ladderId],
      foreignColumns: [clubRankLadders.clubId, clubRankLadders.id],
    }),
    // + club_ranks_position_unique (DEFERRABLE INITIALLY IMMEDIATE, which
    // drizzle cannot declare), the CHECKs, the numbering stamp and the
    // keep-ladder guard — 0056 only.
  ],
);

/**
 * A rank awarded to a client (0056): append-only — a mistake is revoked once.
 * Goes with the client's record (CASCADE) or the club.
 */
export const clubMemberRanks = pgTable(
  'club_member_ranks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    ladderId: uuid('ladder_id').notNull(),
    rankId: uuid('rank_id').notNull(),
    memberId: uuid('member_id').notNull(),
    awardedOn: date('awarded_on').notNull(),
    /** exam | promotion | prior */
    reason: text('reason').notNull(),
    /** The recording member of staff — by value (0039 rule 5). */
    awardedBy: text('awarded_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    revokedAt: timestamptz('revoked_at'),
    /** By value (0039 rule 5). */
    revokedBy: text('revoked_by'),
  },
  (t) => [
    unique('club_member_ranks_club_id_unique').on(t.clubId, t.id),
    index('club_member_ranks_rank_idx').on(t.clubId, t.ladderId, t.rankId),
    foreignKey({
      name: 'club_member_ranks_rank_fk',
      columns: [t.clubId, t.ladderId, t.rankId],
      foreignColumns: [clubRanks.clubId, clubRanks.ladderId, clubRanks.id],
    }),
    foreignKey({
      name: 'club_member_ranks_member_fk',
      columns: [t.clubId, t.memberId],
      foreignColumns: [clubMembers.clubId, clubMembers.id],
    }).onDelete('cascade'),
    // + club_member_ranks_current_idx (with its DESC sort keys), the partial
    // club_member_ranks_once, the CHECKs, the stamp, the never-edited guard
    // and the derived view club_member_rank_progress — 0056 only.
  ],
);

/**
 * A club's API key (0057): SHA-256 only, six characters to tell keys apart,
 * closed scopes. Acts as the member of staff who created it, by value.
 */
export const clubApiKeys = pgTable(
  'club_api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** SHA-256 hex of the key — never the key (CHECK-pinned to 64 hex). */
    keyHash: text('key_hash').notNull(),
    prefix: text('prefix').notNull(),
    scopes: text('scopes').array().notNull(),
    /** The creator — by value (0039 rule 5); the key acts as them. */
    createdBy: text('created_by').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastUsedAt: timestamptz('last_used_at'),
    revokedAt: timestamptz('revoked_at'),
    /** By value (0039 rule 5). */
    revokedBy: text('revoked_by'),
  },
  (t) => [
    unique('club_api_keys_club_id_unique').on(t.clubId, t.id),
    uniqueIndex('club_api_keys_hash_unique').on(t.keyHash),
    // + the partial club_api_keys_club_live_idx and the CHECKs — 0057 only.
  ],
);

/** One row per (key, Idempotency-Key) for a day (0057): an outcome, never a body. */
export const clubApiIdempotency = pgTable(
  'club_api_idempotency',
  {
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    keyId: uuid('key_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    /** pending | done */
    state: text('state').notNull().default('pending'),
    statusCode: smallint('status_code'),
    /** member | booking | checkin */
    resultKind: text('result_kind'),
    resultId: text('result_id'),
    errorCode: text('error_code'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'club_api_idempotency_pkey', columns: [t.keyId, t.idempotencyKey] }),
    index('club_api_idempotency_key_idx').on(t.clubId, t.keyId),
    index('club_api_idempotency_created_idx').on(t.createdAt),
    foreignKey({
      name: 'club_api_idempotency_key_fk',
      columns: [t.clubId, t.keyId],
      foreignColumns: [clubApiKeys.clubId, clubApiKeys.id],
    }).onDelete('cascade'),
  ],
);

/**
 * Where a club wants its events posted (0057). The signing secret is derived
 * from CLUB_WEBHOOK_SECRET, the id and secret_version — never stored.
 */
export const clubWebhookEndpoints = pgTable(
  'club_webhook_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    events: text('events').array().notNull(),
    description: text('description'),
    secretVersion: integer('secret_version').notNull().default(1),
    secretRotatedAt: timestamptz('secret_rotated_at'),
    /** By value (0039 rule 5). */
    createdBy: text('created_by').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    disabledAt: timestamptz('disabled_at'),
    /** manual | failing */
    disabledReason: text('disabled_reason'),
    failingSince: timestamptz('failing_since'),
    lastSuccessAt: timestamptz('last_success_at'),
  },
  (t) => [
    unique('club_webhook_endpoints_club_id_unique').on(t.clubId, t.id),
    // + the partial club_webhook_endpoints_live_idx and the CHECKs — 0057 only.
  ],
);

/**
 * The outbox and delivery log (0057), written only by the enqueue triggers;
 * thin — the event and the ids.
 */
export const clubWebhookDeliveries = pgTable(
  'club_webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    endpointId: uuid('endpoint_id').notNull(),
    event: text('event').notNull(),
    subjectId: text('subject_id').notNull(),
    /** The client record, by value: member.deleted names one that is gone. */
    memberId: uuid('member_id'),
    occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
    /** pending | delivered | failed */
    state: text('state').notNull().default('pending'),
    attempts: smallint('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
    lastAttemptAt: timestamptz('last_attempt_at'),
    lastStatus: smallint('last_status'),
    lastError: text('last_error'),
    deliveredAt: timestamptz('delivered_at'),
  },
  (t) => [
    index('club_webhook_deliveries_endpoint_idx').on(t.clubId, t.endpointId, t.occurredAt),
    index('club_webhook_deliveries_occurred_idx').on(t.occurredAt),
    foreignKey({
      name: 'club_webhook_deliveries_endpoint_fk',
      columns: [t.clubId, t.endpointId],
      foreignColumns: [clubWebhookEndpoints.clubId, clubWebhookEndpoints.id],
    }).onDelete('cascade'),
    // + the partial club_webhook_deliveries_due_idx, the CHECKs and the
    // enqueue triggers on five tables — 0057 only.
  ],
);

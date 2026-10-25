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
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './auth.js';
import { businesses, facilities, municipalities, trainingLogs } from './index.js';

/**
 * The «Клубове» add-on (migrations 0039–0044; docs/ROADMAP.md Stage 9).
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
    /** community (free) | standard | pro */
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
    memberCap: integer('member_cap'),
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
    /** staff | import | self */
    source: text('source').notNull().default('staff'),
    unsubscribeToken: text('unsubscribe_token').notNull(),
    emailOptOutAt: timestamptz('email_opt_out_at'),
    cardTokenHash: text('card_token_hash'),
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
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('club_memberships_club_id_unique').on(t.clubId, t.id),
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
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
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
    /** membership | drop_in | product | fee | other */
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    amountCents: integer('amount_cents').notNull(),
    issuedOn: date('issued_on').notNull(),
    dueOn: date('due_on').notNull(),
    voidedAt: timestamptz('voided_at'),
    createdBy: text('created_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [unique('club_charges_club_id_unique').on(t.clubId, t.id)],
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
    /** cash | card_desk | bank | card_online | other */
    method: text('method').notNull(),
    /** manual | stripe (phase 2) */
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
    /** Wall clock, timestamp WITHOUT time zone (0008's time model). */
    startsAtLocal: timestamp('starts_at_local', { withTimezone: false }).notNull(),
    timezone: text('timezone').notNull().default('Europe/Sofia'),
    rrule: text('rrule'),
    durationMinutes: integer('duration_minutes').notNull(),
    capacity: integer('capacity'),
    bookingOpensHours: integer('booking_opens_hours').notNull().default(168),
    cancelDeadlineHours: integer('cancel_deadline_hours').notNull().default(2),
    dropInPriceCents: integer('drop_in_price_cents'),
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
    /** qr_kiosk | qr_member | card | desk | api */
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
    sentAt: timestamptz('sent_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('club_notifications_dedupe_unique').on(t.clubId, t.dedupeKey),
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
    computedAt: timestamptz('computed_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('club_monthly_activity_club_month_unique').on(t.clubId, t.month)],
);

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

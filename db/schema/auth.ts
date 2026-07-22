import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * better-auth tables (docs/ROADMAP.md §5) — hand-written rather than
 * CLI-generated so the constraints, indexes and privacy guarantees below are
 * reviewable SQL like the rest of db/schema.
 *
 * Property names are the model field names better-auth's adapter looks up
 * (camelCase); column names stay snake_case like every other table here. The
 * one remapped field is `name` → `displayName`: the profile has exactly one
 * human-facing name and it lives in `users.display_name`.
 *
 * THERE IS NO DATE-OF-BIRTH COLUMN, HERE OR ANYWHERE ELSE. A DOB is collected
 * once in the profile form, converted to `is_minor`, and discarded in the same
 * function call (lib/src/age.ts, apps/web/lib/profile.ts). Adding a column that
 * stores it would break apps/web/tests/dob-not-persisted.test.ts on purpose.
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * Authorization ranks, lowest to highest privilege:
 *  - user        signed-in contributor
 *  - ambassador  trusted local contributor (Stage 3 contribution flows)
 *  - moderator   reviews photos/reports; municipality-scoped in a later session
 *  - admin       full admin panel, including imports
 * Extend via ALTER TYPE ... ADD VALUE in a later migration (no table lock).
 */
export const userRole = pgEnum('user_role', ['user', 'ambassador', 'moderator', 'admin']);

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    // better-auth's `name` field, remapped (see auth options `user.fields`).
    displayName: text('display_name').notNull().default(''),
    email: text('email').notNull().unique('users_email_unique'),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    // Free-text city the member plays in; drives local digests in Stage 4.
    homeCity: text('home_city'),
    // Derived from a DOB that is never stored. Drives the minor protections
    // (no individual public leaderboards — CLAUDE.md rules).
    isMinor: boolean('is_minor').notNull().default(false),
    role: userRole('role').notNull().default('user'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('users_email_not_blank', sql`btrim(${t.email}) <> ''`),
    // better-auth normalises to lowercase; enforced so a case variant can never
    // become a second account for the same person.
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
    // Generous cap: the profile form limits input to 60, but this column is
    // also written by better-auth from an OAuth provider's `name`, and a
    // constraint violation there would fail the sign-in rather than trim a
    // profile field. The limit exists to stop unbounded storage, not to
    // enforce the form's rule.
    check('users_display_name_len', sql`char_length(${t.displayName}) <= 200`),
    check(
      'users_home_city_sane',
      sql`${t.homeCity} IS NULL OR (btrim(${t.homeCity}) <> '' AND char_length(${t.homeCity}) <= 80)`,
    ),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique('sessions_token_unique'),
    expiresAt: timestamptz('expires_at').notNull(),
    // Present because better-auth's session model declares it — and constrained
    // to stay empty (see the CHECK). IP tracking is switched off in the auth
    // options; the constraint is the guarantee that it stays off.
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
    // Privacy invariant, enforced by the database rather than by convention:
    // visitor IPs are used transiently for rate-limiting and never persisted
    // (this is what the public privacy page promises). Empty string as well as
    // NULL counts as "no value" — with IP tracking disabled better-auth writes
    // '' rather than NULL, and neither is an address.
    check('sessions_no_ip_stored', sql`coalesce(${t.ipAddress}, '') = ''`),
  ],
);

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamptz('access_token_expires_at'),
    refreshTokenExpiresAt: timestamptz('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('accounts_user_id_idx').on(t.userId),
    uniqueIndex('accounts_provider_account_unique').on(t.providerId, t.accountId),
  ],
);

// Short-lived OTP records. `value` holds a hash, never the code itself
// (auth options: storeOTP: 'hashed'), so a database dump cannot be replayed.
export const verifications = pgTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('verifications_identifier_idx').on(t.identifier),
    index('verifications_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * GDPR erasure tombstone. Deliberately holds no personal data: the opaque user
 * id (now pointing at nothing) plus a count, which is what lets us answer "was
 * this erasure request honoured, and did it disturb the audit log?" without
 * keeping anything about the person who asked.
 */
export const accountDeletions = pgTable(
  'account_deletions',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    userId: text('user_id').notNull(),
    deletedAt: timestamptz('deleted_at').notNull().defaultNow(),
    /** facility_edits rows left untouched — the audit trail survives erasure. */
    auditRowsPreserved: integer('audit_rows_preserved').notNull().default(0),
    /** facility_photos rows whose uploader reference was cleared. */
    photosAnonymized: integer('photos_anonymized').notNull().default(0),
    /** facility_condition_reports rows whose reporter reference was cleared. */
    conditionReportsAnonymized: integer('condition_reports_anonymized').notNull().default(0),
    /**
     * points_ledger rows removed with the account. Points are personal data, so
     * unlike the audit trail they leave — and the tombstone has to be able to
     * evidence that they did.
     */
    pointsErased: integer('points_erased').notNull().default(0),
  },
  (t) => [
    index('account_deletions_deleted_at_idx').on(t.deletedAt),
    // "Was this erasure honoured?" is asked by user_id, against a table that
    // only grows. Deliberately NOT unique: a duplicate tombstone is a harmless
    // bug, while a constraint that can abort an erasure transaction is not.
    index('account_deletions_user_id_idx').on(t.userId),
    check('account_deletions_user_id_not_blank', sql`btrim(${t.userId}) <> ''`),
    check(
      'account_deletions_counts_non_negative',
      sql`${t.auditRowsPreserved} >= 0 AND ${t.photosAnonymized} >= 0
          AND ${t.conditionReportsAnonymized} >= 0 AND ${t.pointsErased} >= 0`,
    ),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserRole = (typeof userRole.enumValues)[number];
export type Session = typeof sessions.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Verification = typeof verifications.$inferSelect;
export type AccountDeletion = typeof accountDeletions.$inferSelect;

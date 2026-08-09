import 'server-only';

import {
  frozenStreakWeeks,
  getDb,
  memberTrainings,
  passportEvents,
  passportTotals,
  sql,
  type TrainingRow,
} from '@sportkarta/db';
import { evaluateBadges, LAUNCH_BADGES, passportStreaks } from '@sportkarta/lib/badges';

import { toRole, type Role } from './roles';

/**
 * Read layer for the admin account-management module (/admin/akaunti).
 *
 * ONE RULE GOVERNS THIS FILE: it may read anything a person's account touches,
 * and it may never read a credential or a coordinate. Concretely, no query here
 * selects `sessions.token`, `accounts.access_token`/`refresh_token`/`id_token`/
 * `password`, `api_keys.key_hash`, `calendar_tokens.token`,
 * `digest_subscriptions.unsubscribe_token` or `training_routes.geom`. The first
 * six are live bearer credentials — rendering one on a support screen hands the
 * account (or the member's whole calendar) to whoever is looking at the monitor,
 * and a screenshot would be a working link. The last is a record of where a
 * named person physically was. `tests/account-admin-projection.test.ts` asserts
 * the absence rather than trusting this comment.
 *
 * The second rule: PREFER AN EXISTING HELPER. `memberTrainings` already returns
 * the safe training projection with `has_route`/`has_metrics` as existence
 * booleans; badges and streaks are DERIVED by folding the event stream, not
 * stored. Re-implementing either here would be how the two drift apart.
 */

const PAGE_SIZE = 50;
export const ACCOUNTS_PAGE_SIZE = PAGE_SIZE;

export interface AccountFilters {
  /** Email prefix or display-name substring. */
  q?: string;
  role?: Role;
  /** Passport publication state. */
  visibility?: 'public' | 'private';
  /** Accounts holding a given consent — the two are separate questions. */
  consent?: 'route' | 'health';
  page: number;
}

export interface AccountListRow {
  id: string;
  email: string;
  displayName: string;
  homeCity: string | null;
  role: Role;
  isPublic: boolean;
  createdAt: string;
  points: number;
  /** `facility_edits` rows this person authored — the audit trail, not a score. */
  edits: number;
  trainings: number;
  checkins: number;
  /** Newest of their own activity timestamps; null for an account that has done nothing. */
  lastActiveAt: string | null;
}

/**
 * The account list.
 *
 * Search is a PREFIX match on email plus a substring match on display name.
 * `users.email` is CHECK-pinned lowercase (`users_email_lowercase`), so the
 * needle is lowered rather than the column — lowering the column would discard
 * the unique index for no benefit, and there is no case variant to catch.
 *
 * The four activity numbers are lateral subqueries rather than joins: a join
 * over five one-to-many tables multiplies rows and then needs a DISTINCT to
 * undo itself, and the counts would silently be wrong rather than slow.
 */
export async function listAccounts(
  filters: AccountFilters,
): Promise<{ rows: AccountListRow[]; total: number }> {
  const conditions = [sql`TRUE`];

  if (filters.q) {
    // LIKE metacharacters in the operator's search would otherwise act as
    // wildcards ("%" alone matches everyone; "_" per character) — escape them
    // so the search always means the literal text typed.
    const needle = filters.q
      .trim()
      .toLowerCase()
      .replace(/[\\%_]/g, (m) => `\\${m}`);
    if (needle) {
      const prefix = `${needle}%`;
      const anywhere = `%${needle}%`;
      conditions.push(sql`(u.email LIKE ${prefix} OR lower(u.display_name) LIKE ${anywhere})`);
    }
  }
  if (filters.role) conditions.push(sql`u.role = ${filters.role}`);
  if (filters.visibility) conditions.push(sql`u.profile_visibility = ${filters.visibility}`);
  if (filters.consent === 'route') conditions.push(sql`u.training_route_consent_at IS NOT NULL`);
  if (filters.consent === 'health') conditions.push(sql`u.training_health_consent_at IS NOT NULL`);

  const where = sql.join(conditions, sql` AND `);
  const offset = Math.max(0, filters.page - 1) * PAGE_SIZE;

  const [rows, count] = await Promise.all([
    getDb().execute(sql`
      SELECT u.id, u.email, u.display_name, u.home_city, u.role,
             (u.profile_visibility = 'public') AS is_public,
             u.created_at,
             COALESCE(p.points, 0) AS points,
             COALESCE(e.edits, 0) AS edits,
             COALESCE(t.trainings, 0) AS trainings,
             COALESCE(c.checkins, 0) AS checkins,
             GREATEST(
               COALESCE(p.last_at, u.created_at),
               COALESCE(t.last_at, u.created_at),
               COALESCE(c.last_at, u.created_at)
             ) AS last_active_at
      FROM users u
      LEFT JOIN LATERAL (
        SELECT SUM(points)::int AS points, MAX(created_at) AS last_at
        FROM points_ledger WHERE user_id = u.id
      ) p ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS edits FROM facility_edits WHERE actor = u.id
      ) e ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS trainings, MAX(started_at) AS last_at
        FROM training_logs WHERE user_id = u.id
      ) t ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS checkins, MAX(checked_in_at) AS last_at
        FROM play_session_checkins WHERE user_id = u.id
      ) c ON TRUE
      WHERE ${where}
      ORDER BY u.created_at DESC
      LIMIT ${PAGE_SIZE} OFFSET ${offset}
    `),
    getDb().execute(sql`SELECT COUNT(*)::int AS n FROM users u WHERE ${where}`),
  ]);

  return {
    rows: rows.rows.map((row) => ({
      id: String(row.id),
      email: String(row.email),
      displayName: String(row.display_name ?? ''),
      homeCity:
        row.home_city === null || row.home_city === undefined ? null : String(row.home_city),
      role: toRole(row.role),
      isPublic: row.is_public === true,
      createdAt: new Date(String(row.created_at)).toISOString(),
      points: Number(row.points ?? 0),
      edits: Number(row.edits ?? 0),
      trainings: Number(row.trainings ?? 0),
      checkins: Number(row.checkins ?? 0),
      lastActiveAt:
        row.last_active_at === null || row.last_active_at === undefined
          ? null
          : new Date(String(row.last_active_at)).toISOString(),
    })),
    total: Number(count.rows[0]?.n ?? 0),
  };
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */

export interface AccountIdentity {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  homeCity: string | null;
  role: Role;
  /**
   * Derived from a date of birth that was never stored, and GATES NOTHING since
   * migration 0020. Rendered as a note, never as an eligibility flag.
   */
  isMinor: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AccountConsent {
  /** Passport publication — opt-in, the only gate on appearing publicly. */
  isPublic: boolean;
  showActivity: boolean;
  /**
   * Whether a handle exists — NOT whether the passport is public. Going private
   * KEEPS the handle so a shared link survives, so these are separate facts.
   */
  hasHandle: boolean;
  /**
   * Consent RECEIPTS, not settings. NULL means "no consent recorded" — which is
   * both "never granted" and "granted then withdrawn", indistinguishable,
   * because there is no consent-event table. Never render as "never consented".
   */
  routeConsentAt: string | null;
  healthConsentAt: string | null;
}

export interface AccountAuthority {
  /** Municipalities this ambassador may moderate. Empty = can decide nothing. */
  scope: { municipalityId: number; nameBg: string; nameEn: string; grantedAt: string }[];
  /** Grants this person ISSUED to others — a different question from their own. */
  grantsIssued: number;
}

export interface AccountPassport {
  points: number;
  facilitiesAdded: number;
  facilitiesVerified: number;
  conditionsReported: number;
  checkins: number;
  memberSince: string | null;
  badges: { slug: string; earnedAt: string | null }[];
  streak: { currentDays: number; longestDays: number; currentWeeks: number; longestWeeks: number };
}

export interface LedgerEntry {
  event: string;
  points: number;
  facilityName: string | null;
  createdAt: string;
}

export interface ContributionEntry {
  facilityId: string;
  facilityName: string | null;
  field: string;
  source: string;
  createdAt: string;
}

export interface DecisionAboutMember {
  targetType: string;
  decision: string;
  facilityName: string | null;
  decidedAt: string;
}

export interface PlayActivity {
  /** Series they organise. One row is "every Tuesday", not each Tuesday. */
  seriesOrganised: number;
  rsvpsActive: number;
  rsvpsWithdrawn: number;
  checkins: { method: string; count: number }[];
  /** Check-ins where this person marked SOMEBODY ELSE present. */
  vouchedForOthers: number;
  resultsRecorded: number;
  resultsAbout: number;
}

export interface CommsActivity {
  digestCities: { municipalityId: number; nameBg: string; nameEn: string; since: string }[];
  digestSends: number;
  lastDigestAt: string | null;
  sessionMailCount: number;
  lastSessionMailAt: string | null;
}

export interface CredentialSummary {
  /** Live sessions. `user_agent` only — no IP is stored anywhere (CHECK-enforced). */
  sessions: { userAgent: string | null; createdAt: string; expiresAt: string }[];
  /** Linked OAuth identities. Never a token — provider and creation date only. */
  providers: { providerId: string; createdAt: string }[];
  apiKeys: {
    label: string;
    prefix: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }[];
  /** Whether a calendar feed URL exists, and when it was last rotated. Never the token. */
  calendar: { issuedAt: string; rotatedAt: string | null } | null;
}

export interface AccountDetail {
  identity: AccountIdentity;
  consent: AccountConsent;
  authority: AccountAuthority;
  passport: AccountPassport;
  ledger: LedgerEntry[];
  contributions: ContributionEntry[];
  photosUploaded: number;
  conditionReports: number;
  decisionsAbout: DecisionAboutMember[];
  decisionsMade: number;
  play: PlayActivity;
  trainings: TrainingRow[];
  comms: CommsActivity;
  credentials: CredentialSummary;
}

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(String(value)).toISOString();
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** The identity row on its own — cheap, and the existence check for the page. */
export async function accountIdentity(userId: string): Promise<AccountIdentity | null> {
  const result = await getDb().execute(sql`
    SELECT id, email, email_verified, display_name, home_city, role, is_minor,
           created_at, updated_at
    FROM users WHERE id = ${userId}
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    email: String(row.email),
    emailVerified: row.email_verified === true,
    displayName: String(row.display_name ?? ''),
    homeCity: textOrNull(row.home_city),
    role: toRole(row.role),
    isMinor: row.is_minor === true,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/**
 * Everything else about one person.
 *
 * Deliberately ONE function rather than a panel-per-call: the page needs all of
 * it, and a dozen sequential awaits in a server component is a dozen round
 * trips. `Promise.all` over independent statements keeps it to one wait.
 */
export async function accountDetail(userId: string): Promise<AccountDetail | null> {
  const identity = await accountIdentity(userId);
  if (!identity) return null;

  const db = getDb();
  const [
    consentRow,
    scopeRows,
    grantsIssued,
    events,
    totals,
    frozen,
    ledgerRows,
    contributionRows,
    photoCount,
    conditionCount,
    decisionsAboutRows,
    decisionsMadeCount,
    playRow,
    checkinMethods,
    digestRows,
    digestSendRow,
    sessionMailRow,
    sessionRows,
    providerRows,
    apiKeyRows,
    calendarRow,
    trainings,
  ] = await Promise.all([
    db.execute(sql`
      SELECT profile_visibility, public_show_activity,
             (public_handle IS NOT NULL) AS has_handle,
             training_route_consent_at, training_health_consent_at
      FROM users WHERE id = ${userId}
    `),
    db.execute(sql`
      SELECT am.municipality_id, m.name_bg, m.name_en, am.granted_at
      FROM ambassador_municipalities am
      JOIN municipalities m ON m.id = am.municipality_id
      WHERE am.user_id = ${userId}
      ORDER BY m.name_bg
    `),
    db.execute(
      sql`SELECT COUNT(*)::int AS n FROM ambassador_municipalities WHERE granted_by = ${userId}`,
    ),
    passportEvents(db, userId),
    passportTotals(db, userId),
    frozenStreakWeeks(db, userId),
    db.execute(sql`
      SELECT l.event, l.points, l.created_at, f.name AS facility_name
      FROM points_ledger l
      LEFT JOIN facilities f ON f.id = l.facility_id
      WHERE l.user_id = ${userId}
      ORDER BY l.created_at DESC
      LIMIT 100
    `),
    db.execute(sql`
      SELECT e.facility_id::text AS facility_id, f.name AS facility_name,
             e.field, e.source::text AS source, e.created_at
      FROM facility_edits e
      LEFT JOIN facilities f ON f.id = e.facility_id
      WHERE e.actor = ${userId}
      ORDER BY e.created_at DESC
      LIMIT 100
    `),
    db.execute(sql`SELECT COUNT(*)::int AS n FROM facility_photos WHERE uploaded_by = ${userId}`),
    db.execute(
      sql`SELECT COUNT(*)::int AS n FROM facility_condition_reports WHERE reporter_id = ${userId}`,
    ),
    /**
     * Decisions ABOUT this person's content — a finding against them, never
     * their contribution. Written as `target_id IN (subquery)` so the
     * `(target_type, target_id)` index is usable; a correlated join written
     * outward from users seq-scans an append-only table that only grows.
     */
    db.execute(sql`
      SELECT d.target_type::text AS target_type, d.decision::text AS decision,
             d.decided_at, f.name AS facility_name
      FROM moderation_decisions d
      LEFT JOIN facilities f ON f.id = d.facility_id
      WHERE (d.target_type = 'photo'
             AND d.target_id IN (SELECT id FROM facility_photos WHERE uploaded_by = ${userId}))
         OR (d.target_type = 'facility'
             AND d.target_id IN (SELECT facility_id FROM facility_edits
                                 WHERE actor = ${userId} AND field = 'created'))
      ORDER BY d.decided_at DESC
      LIMIT 50
    `),
    db.execute(sql`SELECT COUNT(*)::int AS n FROM moderation_decisions WHERE actor_id = ${userId}`),
    db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM play_sessions WHERE organizer_id = ${userId}) AS series_organised,
        (SELECT COUNT(*)::int FROM play_session_rsvps
          WHERE user_id = ${userId} AND state = 'active') AS rsvps_active,
        (SELECT COUNT(*)::int FROM play_session_rsvps
          WHERE user_id = ${userId} AND state = 'withdrawn') AS rsvps_withdrawn,
        (SELECT COUNT(*)::int FROM play_session_checkins
          WHERE recorded_by = ${userId} AND user_id <> ${userId}) AS vouched,
        (SELECT COUNT(*)::int FROM play_session_results
          WHERE recorded_by = ${userId}) AS results_recorded,
        (SELECT COUNT(*)::int FROM play_session_results
          WHERE participant_user_id = ${userId}) AS results_about
    `),
    db.execute(sql`
      SELECT method::text AS method, COUNT(*)::int AS n
      FROM play_session_checkins WHERE user_id = ${userId}
      GROUP BY method ORDER BY method
    `),
    db.execute(sql`
      SELECT d.municipality_id, m.name_bg, m.name_en, d.created_at
      FROM digest_subscriptions d
      JOIN municipalities m ON m.id = d.municipality_id
      WHERE d.user_id = ${userId}
      ORDER BY m.name_bg
    `),
    db.execute(
      sql`SELECT COUNT(*)::int AS n, MAX(sent_at) AS last_at FROM digest_sends WHERE user_id = ${userId}`,
    ),
    db.execute(
      sql`SELECT COUNT(*)::int AS n, MAX(sent_at) AS last_at FROM play_session_notifications WHERE user_id = ${userId}`,
    ),
    /**
     * `user_agent` and the two timestamps only. `token` is a live bearer
     * credential and `ip_address` is CHECK-pinned empty forever — rendering a
     * column of blanks would suggest we hold addresses we deliberately do not.
     */
    db.execute(sql`
      SELECT user_agent, created_at, expires_at
      FROM sessions WHERE user_id = ${userId}
      ORDER BY expires_at DESC LIMIT 20
    `),
    db.execute(sql`
      SELECT provider_id, created_at FROM accounts WHERE user_id = ${userId}
      ORDER BY created_at
    `),
    db.execute(sql`
      SELECT label, prefix, created_at, last_used_at, revoked_at
      FROM api_keys WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `),
    db.execute(sql`SELECT created_at, rotated_at FROM calendar_tokens WHERE user_id = ${userId}`),
    memberTrainings(db, userId, 100),
  ]);

  const consentSrc = consentRow.rows[0] ?? {};
  const now = new Date();
  const badges = evaluateBadges(LAUNCH_BADGES, events, { now });
  const streaks = passportStreaks(events, { now, frozen });
  const play = playRow.rows[0] ?? {};
  const digestSend = digestSendRow.rows[0] ?? {};
  const sessionMail = sessionMailRow.rows[0] ?? {};
  const calendar = calendarRow.rows[0];

  return {
    identity,
    consent: {
      isPublic: consentSrc.profile_visibility === 'public',
      showActivity: consentSrc.public_show_activity === true,
      hasHandle: consentSrc.has_handle === true,
      routeConsentAt: isoOrNull(consentSrc.training_route_consent_at),
      healthConsentAt: isoOrNull(consentSrc.training_health_consent_at),
    },
    authority: {
      scope: scopeRows.rows.map((row) => ({
        municipalityId: Number(row.municipality_id),
        nameBg: String(row.name_bg),
        nameEn: String(row.name_en),
        grantedAt: iso(row.granted_at),
      })),
      grantsIssued: Number(grantsIssued.rows[0]?.n ?? 0),
    },
    passport: {
      points: totals.points,
      facilitiesAdded: totals.facilitiesAdded,
      facilitiesVerified: totals.facilitiesVerified,
      conditionsReported: totals.conditionsReported,
      checkins: totals.checkins,
      memberSince: totals.memberSince,
      badges: badges
        .filter((badge) => badge.earnedAt !== null)
        .map((badge) => ({
          slug: badge.slug,
          earnedAt: badge.earnedAt ? badge.earnedAt.toISOString() : null,
        })),
      streak: {
        currentDays: streaks.days.current,
        longestDays: streaks.days.longest,
        currentWeeks: streaks.weeks.current,
        longestWeeks: streaks.weeks.longest,
      },
    },
    ledger: ledgerRows.rows.map((row) => ({
      event: String(row.event),
      points: Number(row.points),
      facilityName: textOrNull(row.facility_name),
      createdAt: iso(row.created_at),
    })),
    contributions: contributionRows.rows.map((row) => ({
      facilityId: String(row.facility_id),
      facilityName: textOrNull(row.facility_name),
      field: String(row.field),
      source: String(row.source),
      createdAt: iso(row.created_at),
    })),
    photosUploaded: Number(photoCount.rows[0]?.n ?? 0),
    conditionReports: Number(conditionCount.rows[0]?.n ?? 0),
    decisionsAbout: decisionsAboutRows.rows.map((row) => ({
      targetType: String(row.target_type),
      decision: String(row.decision),
      facilityName: textOrNull(row.facility_name),
      decidedAt: iso(row.decided_at),
    })),
    decisionsMade: Number(decisionsMadeCount.rows[0]?.n ?? 0),
    play: {
      seriesOrganised: Number(play.series_organised ?? 0),
      rsvpsActive: Number(play.rsvps_active ?? 0),
      rsvpsWithdrawn: Number(play.rsvps_withdrawn ?? 0),
      checkins: checkinMethods.rows.map((row) => ({
        method: String(row.method),
        count: Number(row.n),
      })),
      vouchedForOthers: Number(play.vouched ?? 0),
      resultsRecorded: Number(play.results_recorded ?? 0),
      resultsAbout: Number(play.results_about ?? 0),
    },
    trainings,
    comms: {
      digestCities: digestRows.rows.map((row) => ({
        municipalityId: Number(row.municipality_id),
        nameBg: String(row.name_bg),
        nameEn: String(row.name_en),
        since: iso(row.created_at),
      })),
      digestSends: Number(digestSend.n ?? 0),
      lastDigestAt: isoOrNull(digestSend.last_at),
      sessionMailCount: Number(sessionMail.n ?? 0),
      lastSessionMailAt: isoOrNull(sessionMail.last_at),
    },
    credentials: {
      sessions: sessionRows.rows.map((row) => ({
        userAgent: textOrNull(row.user_agent),
        createdAt: iso(row.created_at),
        expiresAt: iso(row.expires_at),
      })),
      providers: providerRows.rows.map((row) => ({
        providerId: String(row.provider_id),
        createdAt: iso(row.created_at),
      })),
      apiKeys: apiKeyRows.rows.map((row) => ({
        label: String(row.label),
        prefix: String(row.prefix),
        createdAt: iso(row.created_at),
        lastUsedAt: isoOrNull(row.last_used_at),
        revokedAt: isoOrNull(row.revoked_at),
      })),
      calendar: calendar
        ? { issuedAt: iso(calendar.created_at), rotatedAt: isoOrNull(calendar.rotated_at) }
        : null,
    },
  };
}

import { frozenStreakWeeks, passportEvents, passportTotals, sql, type SQL } from '@sportkarta/db';
import { evaluateBadges, LAUNCH_BADGES, passportStreaks } from '@sportkarta/lib/badges';

/**
 * One member's record as a machine-readable file — GDPR Art. 15 (access) and
 * Art. 20 (portability). Two routes serve it: the member's own download on
 * /profil, and the admin's on /admin/akaunti/[id] for someone who writes in
 * because they can no longer sign in. Both build the SAME document here, so the
 * copy a member downloads and the copy the operator mails them cannot drift.
 *
 * COMPLETE, NOT A SCREEN. The admin account screen caps its tables (100 ledger
 * rows, 100 trainings) because it is for reading; an export that silently
 * stopped at row 100 would be an incomplete answer to a legal request. Nothing
 * here has a LIMIT.
 *
 * THE SAME PROJECTION RULE AS lib/account-admin.ts: no live credential and no
 * coordinate ever enters this file. Concretely, no session token, OAuth token,
 * API key hash, calendar feed token or digest unsubscribe token — each is a
 * working key, and an export file is the copy of an account most likely to be
 * forwarded, attached or left in a downloads folder. And no GPS geometry or
 * heart-rate value: those tables carry an explicit "no export" rule in their
 * own migration (0027) that only an operator decision may lift. Their EXISTENCE
 * is exported per training, and `withheld` lists every category left out, so
 * the file says what it does not contain rather than implying it is everything.
 * `tests/account-admin-projection.test.ts` scans this file for all of the above.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export const ACCOUNT_EXPORT_FORMAT = 'pops-account-export';
export const ACCOUNT_EXPORT_VERSION = 1;

/**
 * Categories deliberately left out, as stable codes. Codes rather than prose:
 * this is a data file, read by whatever the member imports it into, and a
 * sentence here would be UI copy outside the message catalogue.
 */
export const EXPORT_WITHHELD = [
  'session_tokens',
  'oauth_tokens',
  'api_key_hashes',
  'calendar_feed_token',
  'digest_unsubscribe_tokens',
  'training_route_geometry',
  'training_heart_rate_and_calories',
] as const;

type Row = Record<string, unknown>;

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export interface AccountExport {
  format: typeof ACCOUNT_EXPORT_FORMAT;
  version: number;
  generatedAt: string;
  withheld: readonly string[];
  account: {
    id: string;
    email: string;
    emailVerified: boolean;
    displayName: string;
    homeCity: string | null;
    role: string;
    /** Derived from a date of birth that was never stored; gates nothing (0020). */
    isMinor: boolean;
    createdAt: string;
    updatedAt: string;
    suspension: { since: string; reason: string } | null;
  };
  consents: {
    passportPublic: boolean;
    passportShowsActivity: boolean;
    passportHasShareLink: boolean;
    trainingRouteConsentAt: string | null;
    trainingHealthConsentAt: string | null;
  };
  moderationScope: { municipalityId: number; nameBg: string; nameEn: string; grantedAt: string }[];
  passport: {
    totals: {
      points: number;
      facilitiesAdded: number;
      facilitiesVerified: number;
      conditionsReported: number;
      checkins: number;
    };
    badges: { slug: string; earnedAt: string | null }[];
    streaks: {
      currentDays: number;
      longestDays: number;
      currentWeeks: number;
      longestWeeks: number;
    };
    streakFreezes: { unit: string; period: string; appliedAt: string }[];
    divisions: { groupId: number; weekStart: string }[];
  };
  pointsLedger: {
    event: string;
    points: number;
    facilityId: string | null;
    facilityName: string | null;
    createdAt: string;
  }[];
  contributions: {
    facilityEdits: {
      facilityId: string;
      facilityName: string | null;
      field: string;
      source: string;
      newValue: unknown;
      createdAt: string;
    }[];
    photos: {
      id: string;
      facilityId: string;
      facilityName: string | null;
      status: string;
      createdAt: string;
    }[];
    conditionReports: {
      facilityId: string;
      facilityName: string | null;
      state: string;
      tags: string[];
      createdAt: string;
    }[];
  };
  play: {
    sessionsOrganised: {
      id: string;
      title: string;
      sport: string;
      status: string;
      createdAt: string;
    }[];
    rsvps: {
      occurrenceId: string;
      sessionTitle: string | null;
      startsAtLocal: string | null;
      state: string;
      createdAt: string;
      withdrawnAt: string | null;
    }[];
    checkins: {
      occurrenceId: string;
      method: string;
      scored: boolean;
      distanceM: number | null;
      checkedInAt: string;
    }[];
    results: {
      occurrenceId: string;
      team: string | null;
      position: number | null;
      score: string | null;
      note: string | null;
      createdAt: string;
    }[];
    campaignResults: {
      campaignId: string;
      campaignSlug: string | null;
      rank: number;
      score: number;
      createdAt: string;
    }[];
  };
  trainings: {
    id: string;
    sport: string;
    startedAt: string;
    sofiaDay: string;
    durationS: number;
    distanceM: number | null;
    elevationM: number | null;
    facilityId: string | null;
    facilityName: string | null;
    source: string;
    evidence: string;
    note: string | null;
    hasRoute: boolean;
    hasHealthMetrics: boolean;
    createdAt: string;
  }[];
  communications: {
    digestSubscriptions: {
      municipalityId: number;
      nameBg: string;
      nameEn: string;
      since: string;
    }[];
    digestSends: { municipalityId: number; weekStart: string; sentAt: string }[];
    sessionNotifications: { occurrenceId: string; kind: string; sentAt: string }[];
  };
  credentials: {
    sessions: { userAgent: string | null; createdAt: string; expiresAt: string }[];
    linkedProviders: { providerId: string; createdAt: string }[];
    apiKeys: {
      label: string;
      prefix: string;
      createdAt: string;
      lastUsedAt: string | null;
      revokedAt: string | null;
    }[];
    calendarFeed: { issuedAt: string; rotatedAt: string | null } | null;
  };
  /** When an admin opened this account, and which part — the 0028 log, minus who. */
  adminAccess: { scope: string; at: string }[];
  /** What an admin changed on this account — the 0033 log, minus who. */
  adminActions: { action: string; at: string }[];
}

/**
 * Build the export, or null when the account does not exist.
 *
 * Independent statements in one `Promise.all`, like accountDetail: one wait,
 * not two dozen. The admin identities in the two logs are left out on purpose
 * — the member is entitled to know THAT their account was opened or changed
 * and when; the names of staff are the organisation's to disclose on request.
 */
export async function buildAccountExport(
  db: SqlRunner,
  userId: string,
  now: Date = new Date(),
): Promise<AccountExport | null> {
  const found = await db.execute(sql`
    SELECT id, email, email_verified, display_name, home_city, role::text AS role, is_minor,
           profile_visibility::text AS profile_visibility, public_show_activity,
           (public_handle IS NOT NULL) AS has_handle,
           training_route_consent_at, training_health_consent_at,
           suspended_at, suspended_reason, created_at, updated_at
    FROM users WHERE id = ${userId}
  `);
  const user = found.rows[0];
  if (!user) return null;

  const [
    scopeRows,
    events,
    totals,
    frozen,
    freezeRows,
    divisionRows,
    ledgerRows,
    editRows,
    photoRows,
    conditionRows,
    organisedRows,
    rsvpRows,
    checkinRows,
    resultRows,
    campaignRows,
    trainingRows,
    digestRows,
    digestSendRows,
    notificationRows,
    sessionRows,
    providerRows,
    apiKeyRows,
    calendarRows,
    accessRows,
    actionRows,
  ] = await Promise.all([
    db.execute(sql`
      SELECT am.municipality_id, m.name_bg, m.name_en, am.granted_at
      FROM ambassador_municipalities am
      JOIN municipalities m ON m.id = am.municipality_id
      WHERE am.user_id = ${userId}
      ORDER BY m.name_bg
    `),
    passportEvents(db, userId),
    passportTotals(db, userId),
    frozenStreakWeeks(db, userId),
    db.execute(sql`
      SELECT unit, to_char(bucket_key, 'YYYY-MM-DD') AS period, applied_at
      FROM streak_freezes WHERE user_id = ${userId}
      ORDER BY applied_at
    `),
    db.execute(sql`
      SELECT group_id, to_char(week_start, 'YYYY-MM-DD') AS week_start
      FROM division_members WHERE user_id = ${userId}
      ORDER BY week_start
    `),
    db.execute(sql`
      SELECT l.event::text AS event, l.points, l.facility_id::text AS facility_id,
             f.name AS facility_name, l.created_at
      FROM points_ledger l
      LEFT JOIN facilities f ON f.id = l.facility_id
      WHERE l.user_id = ${userId}
      ORDER BY l.created_at, l.id
    `),
    db.execute(sql`
      SELECT e.facility_id::text AS facility_id, f.name AS facility_name, e.field,
             e.source::text AS source, e.new_value, e.created_at
      FROM facility_edits e
      LEFT JOIN facilities f ON f.id = e.facility_id
      WHERE e.actor = ${userId}
      ORDER BY e.created_at, e.id
    `),
    db.execute(sql`
      SELECT p.id::text AS id, p.facility_id::text AS facility_id, f.name AS facility_name,
             p.status::text AS status, p.created_at
      FROM facility_photos p
      LEFT JOIN facilities f ON f.id = p.facility_id
      WHERE p.uploaded_by = ${userId}
      ORDER BY p.created_at
    `),
    db.execute(sql`
      SELECT c.facility_id::text AS facility_id, f.name AS facility_name,
             c.state::text AS state, c.tags, c.created_at
      FROM facility_condition_reports c
      LEFT JOIN facilities f ON f.id = c.facility_id
      WHERE c.reporter_id = ${userId}
      ORDER BY c.created_at
    `),
    db.execute(sql`
      SELECT id::text AS id, title, sport, status::text AS status, created_at
      FROM play_sessions WHERE organizer_id = ${userId}
      ORDER BY created_at
    `),
    db.execute(sql`
      SELECT r.occurrence_id::text AS occurrence_id, s.title AS session_title,
             to_char(o.starts_at_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at_local,
             r.state::text AS state, r.created_at, r.withdrawn_at
      FROM play_session_rsvps r
      LEFT JOIN play_session_occurrences o ON o.id = r.occurrence_id
      LEFT JOIN play_sessions s ON s.id = o.session_id
      WHERE r.user_id = ${userId}
      ORDER BY r.created_at
    `),
    db.execute(sql`
      SELECT occurrence_id::text AS occurrence_id, method::text AS method, scored,
             distance_m, checked_in_at
      FROM play_session_checkins WHERE user_id = ${userId}
      ORDER BY checked_in_at
    `),
    db.execute(sql`
      SELECT occurrence_id::text AS occurrence_id, team, position, score, note, created_at
      FROM play_session_results WHERE participant_user_id = ${userId}
      ORDER BY created_at
    `),
    db.execute(sql`
      SELECT r.campaign_id::text AS campaign_id, c.slug, r.rank, r.score, r.created_at
      FROM campaign_results r
      LEFT JOIN campaigns c ON c.id = r.campaign_id
      WHERE r.user_id = ${userId}
      ORDER BY r.created_at
    `),
    // Existence only, as in memberTrainings — which cannot be reused here
    // because it caps at 200 rows and an export must not.
    db.execute(sql`
      SELECT t.id::text AS id, t.sport, t.started_at,
             to_char(t.sofia_day, 'YYYY-MM-DD') AS sofia_day, t.duration_s, t.distance_m,
             t.elevation_m, t.facility_id::text AS facility_id, f.name AS facility_name,
             t.source::text AS source, t.evidence::text AS evidence, t.note, t.created_at,
             EXISTS (SELECT 1 FROM training_routes r WHERE r.training_log_id = t.id) AS has_route,
             EXISTS (SELECT 1 FROM training_metrics m WHERE m.training_log_id = t.id) AS has_metrics
      FROM training_logs t
      LEFT JOIN facilities f ON f.id = t.facility_id
      WHERE t.user_id = ${userId}
      ORDER BY t.started_at
    `),
    db.execute(sql`
      SELECT d.municipality_id, m.name_bg, m.name_en, d.created_at
      FROM digest_subscriptions d
      JOIN municipalities m ON m.id = d.municipality_id
      WHERE d.user_id = ${userId}
      ORDER BY m.name_bg
    `),
    db.execute(sql`
      SELECT municipality_id, to_char(week_start, 'YYYY-MM-DD') AS week_start, sent_at
      FROM digest_sends WHERE user_id = ${userId}
      ORDER BY sent_at
    `),
    db.execute(sql`
      SELECT occurrence_id::text AS occurrence_id, kind::text AS kind, sent_at
      FROM play_session_notifications WHERE user_id = ${userId}
      ORDER BY sent_at
    `),
    db.execute(sql`
      SELECT user_agent, created_at, expires_at
      FROM sessions WHERE user_id = ${userId}
      ORDER BY created_at
    `),
    db.execute(sql`
      SELECT provider_id, created_at FROM accounts WHERE user_id = ${userId}
      ORDER BY created_at
    `),
    db.execute(sql`
      SELECT label, prefix, created_at, last_used_at, revoked_at
      FROM api_keys WHERE user_id = ${userId}
      ORDER BY created_at
    `),
    db.execute(sql`SELECT created_at, rotated_at FROM calendar_tokens WHERE user_id = ${userId}`),
    db.execute(sql`
      SELECT scope::text AS scope, viewed_at FROM account_access_log
      WHERE subject_id = ${userId}
      ORDER BY viewed_at
    `),
    db.execute(sql`
      SELECT action::text AS action, acted_at FROM admin_actions
      WHERE subject_id = ${userId}
      ORDER BY acted_at
    `),
  ]);

  const badges = evaluateBadges(LAUNCH_BADGES, events, { now });
  const streaks = passportStreaks(events, { now, frozen });
  const calendar: Row | undefined = calendarRows.rows[0];

  return {
    format: ACCOUNT_EXPORT_FORMAT,
    version: ACCOUNT_EXPORT_VERSION,
    generatedAt: now.toISOString(),
    withheld: EXPORT_WITHHELD,
    account: {
      id: String(user.id),
      email: String(user.email),
      emailVerified: user.email_verified === true,
      displayName: String(user.display_name ?? ''),
      homeCity: textOrNull(user.home_city),
      role: String(user.role),
      isMinor: user.is_minor === true,
      createdAt: iso(user.created_at),
      updatedAt: iso(user.updated_at),
      suspension:
        user.suspended_at === null || user.suspended_at === undefined
          ? null
          : { since: iso(user.suspended_at), reason: String(user.suspended_reason ?? '') },
    },
    consents: {
      passportPublic: user.profile_visibility === 'public',
      passportShowsActivity: user.public_show_activity === true,
      passportHasShareLink: user.has_handle === true,
      trainingRouteConsentAt: isoOrNull(user.training_route_consent_at),
      trainingHealthConsentAt: isoOrNull(user.training_health_consent_at),
    },
    moderationScope: scopeRows.rows.map((row) => ({
      municipalityId: Number(row.municipality_id),
      nameBg: String(row.name_bg),
      nameEn: String(row.name_en),
      grantedAt: iso(row.granted_at),
    })),
    passport: {
      totals: {
        points: totals.points,
        facilitiesAdded: totals.facilitiesAdded,
        facilitiesVerified: totals.facilitiesVerified,
        conditionsReported: totals.conditionsReported,
        checkins: totals.checkins,
      },
      badges: badges
        .filter((badge) => badge.earnedAt !== null)
        .map((badge) => ({
          slug: badge.slug,
          earnedAt: badge.earnedAt ? badge.earnedAt.toISOString() : null,
        })),
      streaks: {
        currentDays: streaks.days.current,
        longestDays: streaks.days.longest,
        currentWeeks: streaks.weeks.current,
        longestWeeks: streaks.weeks.longest,
      },
      streakFreezes: freezeRows.rows.map((row) => ({
        unit: String(row.unit),
        period: String(row.period),
        appliedAt: iso(row.applied_at),
      })),
      divisions: divisionRows.rows.map((row) => ({
        groupId: Number(row.group_id),
        weekStart: String(row.week_start),
      })),
    },
    pointsLedger: ledgerRows.rows.map((row) => ({
      event: String(row.event),
      points: Number(row.points),
      facilityId: textOrNull(row.facility_id),
      facilityName: textOrNull(row.facility_name),
      createdAt: iso(row.created_at),
    })),
    contributions: {
      facilityEdits: editRows.rows.map((row) => ({
        facilityId: String(row.facility_id),
        facilityName: textOrNull(row.facility_name),
        field: String(row.field),
        source: String(row.source),
        newValue: row.new_value ?? null,
        createdAt: iso(row.created_at),
      })),
      photos: photoRows.rows.map((row) => ({
        id: String(row.id),
        facilityId: String(row.facility_id),
        facilityName: textOrNull(row.facility_name),
        status: String(row.status),
        createdAt: iso(row.created_at),
      })),
      conditionReports: conditionRows.rows.map((row) => ({
        facilityId: String(row.facility_id),
        facilityName: textOrNull(row.facility_name),
        state: String(row.state),
        tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
        createdAt: iso(row.created_at),
      })),
    },
    play: {
      sessionsOrganised: organisedRows.rows.map((row) => ({
        id: String(row.id),
        title: String(row.title),
        sport: String(row.sport),
        status: String(row.status),
        createdAt: iso(row.created_at),
      })),
      rsvps: rsvpRows.rows.map((row) => ({
        occurrenceId: String(row.occurrence_id),
        sessionTitle: textOrNull(row.session_title),
        startsAtLocal: textOrNull(row.starts_at_local),
        state: String(row.state),
        createdAt: iso(row.created_at),
        withdrawnAt: isoOrNull(row.withdrawn_at),
      })),
      checkins: checkinRows.rows.map((row) => ({
        occurrenceId: String(row.occurrence_id),
        method: String(row.method),
        scored: row.scored === true,
        distanceM: numberOrNull(row.distance_m),
        checkedInAt: iso(row.checked_in_at),
      })),
      results: resultRows.rows.map((row) => ({
        occurrenceId: String(row.occurrence_id),
        team: textOrNull(row.team),
        position: numberOrNull(row.position),
        score: textOrNull(row.score),
        note: textOrNull(row.note),
        createdAt: iso(row.created_at),
      })),
      campaignResults: campaignRows.rows.map((row) => ({
        campaignId: String(row.campaign_id),
        campaignSlug: textOrNull(row.slug),
        rank: Number(row.rank),
        score: Number(row.score),
        createdAt: iso(row.created_at),
      })),
    },
    trainings: trainingRows.rows.map((row) => ({
      id: String(row.id),
      sport: String(row.sport),
      startedAt: iso(row.started_at),
      sofiaDay: String(row.sofia_day),
      durationS: Number(row.duration_s),
      distanceM: numberOrNull(row.distance_m),
      elevationM: numberOrNull(row.elevation_m),
      facilityId: textOrNull(row.facility_id),
      facilityName: textOrNull(row.facility_name),
      source: String(row.source),
      evidence: String(row.evidence),
      note: textOrNull(row.note),
      hasRoute: row.has_route === true,
      hasHealthMetrics: row.has_metrics === true,
      createdAt: iso(row.created_at),
    })),
    communications: {
      digestSubscriptions: digestRows.rows.map((row) => ({
        municipalityId: Number(row.municipality_id),
        nameBg: String(row.name_bg),
        nameEn: String(row.name_en),
        since: iso(row.created_at),
      })),
      digestSends: digestSendRows.rows.map((row) => ({
        municipalityId: Number(row.municipality_id),
        weekStart: String(row.week_start),
        sentAt: iso(row.sent_at),
      })),
      sessionNotifications: notificationRows.rows.map((row) => ({
        occurrenceId: String(row.occurrence_id),
        kind: String(row.kind),
        sentAt: iso(row.sent_at),
      })),
    },
    credentials: {
      sessions: sessionRows.rows.map((row) => ({
        userAgent: textOrNull(row.user_agent),
        createdAt: iso(row.created_at),
        expiresAt: iso(row.expires_at),
      })),
      linkedProviders: providerRows.rows.map((row) => ({
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
      calendarFeed: calendar
        ? { issuedAt: iso(calendar.created_at), rotatedAt: isoOrNull(calendar.rotated_at) }
        : null,
    },
    adminAccess: accessRows.rows.map((row) => ({
      scope: String(row.scope),
      at: iso(row.viewed_at),
    })),
    adminActions: actionRows.rows.map((row) => ({
      action: String(row.action),
      at: iso(row.acted_at),
    })),
  };
}

/**
 * The download's filename. ASCII only and derived from nothing the member
 * typed — a display name in a Content-Disposition header is an injection
 * vector and, in a downloads folder, a label nobody asked for.
 */
export function accountExportFilename(now: Date, userId?: string): string {
  const day = now.toISOString().slice(0, 10);
  const id = userId ? `-${userId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}` : '';
  return `pops-account${id}-${day}.json`;
}

/** Serve an export as a file. Never cached anywhere: it is one person's whole record. */
export function accountExportResponse(data: AccountExport, filename: string): Response {
  return new Response(`${JSON.stringify(data, null, 2)}\n`, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

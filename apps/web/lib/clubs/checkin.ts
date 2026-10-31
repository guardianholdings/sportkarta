import { getDb, sql, type SQL } from '@sportkarta/db';
import {
  PASSPORT_CHECKIN_METHODS,
  isClubSport,
  trainingSportFor,
  type ClubCheckinMethod,
  type IsoDate,
} from '@sportkarta/lib/clubs';
import { sha256Hex } from '@sportkarta/lib/clubs/secrets';

import { clubWritableSql } from './access';
import { recordClubAudit } from './audit';
import { clubActorMay, clubScope, type ClubActor } from './scope';

/**
 * ATTENDANCE AT A CLUB — one transaction, six ways in (0043, 0057).
 *
 *   desk       staff ticked «Присъства» (the desk search, or the roster)
 *   qr_member  the desk scanned the client's per-club QR (/klub/<slug>/skan/<token>)
 *   card       the desk scanned a printed member card
 *   qr_kiosk   the client's phone scanned the tablet's QR (/klubove/otmetka/<token>);
 *              WHO is the session cookie, never the token
 *   api        an integration, through a key that acts as its creator (0057)
 *   door       a door controller read the client's card or member QR (0057):
 *              the ONE way in that may say no — a door that opens for nobody
 *              is the club's rule ('covered'), and a refused door records
 *              nothing, because nobody came in
 *
 * THE ALGORITHM:
 *   1. resolve the client record (and refuse a staff actor out of scope);
 *   2. resolve the class: the one given (roster), else the client's booking
 *      at this location that is about to start or running, else none — an
 *      open-gym visit. A kiosk scan never guesses a class the client did not
 *      book;
 *   3. LOCK the client's memberships (FOR NO KEY UPDATE) before counting, so
 *      two desks — or kiosk and desk — cannot both spend a card's last visit
 *      (the migration review's race);
 *   4. pick the covering abonnement from club_membership_balances: live, the
 *      right audience, accepted by the class; unlimited before visit cards,
 *      then the one ending soonest;
 *   5. INSERT … ON CONFLICT DO NOTHING — a second scan is harmless;
 *   6. the passport bridge: for a QR/card scan by a LINKED client who
 *      CONSENTED, the client's own training_logs row (source 'club', evidence
 *      'qr_verified'); the database re-checks all of that (0043 trigger).
 *
 * NEVER A REFUSAL. An expired, exhausted or unpaid client is RECORDED with
 * covered = false and the desk is told so in words (0014's principle).
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

/** A booked class counts as "now" from this long before its start. */
export const CHECKIN_EARLY_MINUTES = 60;
/** Open-gym visits are logged to the passport as this long. */
export const OPEN_GYM_MINUTES = 60;

export type CheckinRequest =
  | {
      method: 'desk';
      actor: ClubActor;
      memberId: string;
      occurrenceId?: string | null;
      locationId?: string | null;
    }
  | { method: 'qr_member'; actor: ClubActor; memberId: string; locationId?: string | null }
  | { method: 'card'; actor: ClubActor; cardKey: string; locationId?: string | null }
  | { method: 'qr_kiosk'; userId: string; clubId: string; locationId: string }
  | {
      method: 'api';
      actor: ClubActor;
      memberId: string;
      occurrenceId?: string | null;
      locationId?: string | null;
    }
  | { method: 'door'; clubId: string; deviceId: string; credential: DoorCredential };

/** What a door controller read: a printed card, or a member QR already verified. */
export type DoorCredential =
  { kind: 'card'; cardKey: string } | { kind: 'member'; memberId: string };

export interface CheckinOutcome {
  status:
    | 'recorded'
    | 'already'
    | 'not_found'
    | 'not_linked'
    | 'not_allowed'
    | 'club_closed'
    | 'too_early'
    | 'denied';
  /** Why a door stayed shut (method 'door' only). */
  denial?: 'archived' | 'not_covered';
  /** The visit's club_checkins row — this one, or the one already there. */
  checkinId?: string;
  memberId?: string;
  memberName?: string;
  isMinor?: boolean;
  covered?: boolean;
  membership?: {
    planName: string;
    kind: string;
    visitsRemaining: number | null;
    endsOn: IsoDate;
  } | null;
  classTitle?: string | null;
  classStart?: string | null;
  passport?: boolean;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** node-postgres hands timestamptz back as a Date; pass it on exactly. */
function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export async function clubCheckIn(
  db: TransactionalDb,
  request: CheckinRequest,
): Promise<CheckinOutcome> {
  return db.transaction(async (tx) => {
    const clubId =
      request.method === 'qr_kiosk' || request.method === 'door'
        ? request.clubId
        : request.actor.clubId;

    // The club must be operating; a lapsed or suspended club's kiosk and desk
    // record nothing (writes are an entitlement, 0039).
    const club = await tx.execute(sql`
      SELECT c.id, c.sports FROM clubs c
       WHERE c.id = ${clubId}::uuid AND ${clubWritableSql('c')}
    `);
    if (club.rows.length === 0) return { status: 'club_closed' };

    // 1. The client record, and the actor's right to record it.
    let memberId: string | null = null;
    let linkUserId: string | null = null;
    let doorRule: string | null = null;
    let doorLocation: string | null = null;
    if (request.method === 'door') {
      // The controller is live, a door, and this club's — in this transaction.
      const device = await tx.execute(sql`
        SELECT location_id, access_rule FROM club_kiosk_devices
         WHERE id = ${request.deviceId}::uuid AND club_id = ${clubId}::uuid AND kind = 'door'
           AND revoked_at IS NULL
      `);
      doorRule = text(device.rows[0]?.access_rule);
      doorLocation = text(device.rows[0]?.location_id);
      if (!doorRule || !doorLocation) return { status: 'not_allowed' };
      const credential = request.credential;
      const found = await tx.execute(sql`
        SELECT id, display_name, archived_at FROM club_members
         WHERE club_id = ${clubId}::uuid
           AND ${
             credential.kind === 'card'
               ? sql`card_token_hash = ${sha256Hex(credential.cardKey)}`
               : sql`id = ${credential.memberId}::uuid`
           }
      `);
      const record = found.rows[0];
      if (!record) return { status: 'not_found' };
      if (record.archived_at) {
        return {
          status: 'denied',
          denial: 'archived',
          memberId: String(record.id),
          memberName: String(record.display_name),
        };
      }
      memberId = String(record.id);
      const link = await tx.execute(sql`
        SELECT user_id FROM club_member_links
         WHERE club_id = ${clubId}::uuid AND member_id = ${memberId}::uuid AND status = 'active'
           AND passport_consent_at IS NOT NULL
      `);
      linkUserId = text(link.rows[0]?.user_id);
    } else if (request.method === 'qr_kiosk') {
      const linked = await tx.execute(sql`
        SELECT member_id, (passport_consent_at IS NOT NULL) AS consent FROM club_member_links
         WHERE club_id = ${clubId}::uuid AND user_id = ${request.userId} AND status = 'active'
      `);
      memberId = text(linked.rows[0]?.member_id);
      if (!memberId) return { status: 'not_linked' };
      // The passport bridge is opt-in: without consent the visit is recorded
      // and nothing reaches training_logs (whose 0043 trigger would refuse it).
      linkUserId = linked.rows[0]?.consent === true ? request.userId : null;
    } else {
      const allowed = await tx.execute(sql`
        SELECT (${clubActorMay(request.actor, 'attendance.record', { write: true })}) AS full
         WHERE ${clubActorMay(request.actor, 'attendance.record', { write: true })}
           OR (${request.method === 'desk' && request.occurrenceId ? sql`TRUE` : sql`FALSE`}
               AND ${clubActorMay(request.actor, 'attendance.record_own', { write: true })}
               AND EXISTS (SELECT 1 FROM club_class_occurrences o JOIN club_classes k ON k.id = o.class_id
                            WHERE o.id = ${request.method === 'desk' ? (request.occurrenceId ?? null) : null}::uuid
                              AND o.club_id = ${clubId}::uuid
                              AND coalesce(o.instructor_user_id, k.instructor_user_id) = ${request.actor.userId}))
      `);
      if (allowed.rows.length === 0) return { status: 'not_allowed' };
      const ownClassOnly = allowed.rows[0]?.full !== true;
      if (request.method === 'card') {
        const card = await tx.execute(sql`
          SELECT id FROM club_members
           WHERE club_id = ${clubId}::uuid AND card_token_hash = ${sha256Hex(request.cardKey)}
             AND archived_at IS NULL
        `);
        memberId = text(card.rows[0]?.id);
      } else {
        // A trainer ticking their own class (record_own) names only somebody
        // on its list — booked, or in line — never any client of the club.
        const member = await tx.execute(sql`
          SELECT m.id FROM club_members m
           WHERE m.club_id = ${clubId}::uuid AND m.id = ${request.memberId}::uuid
             AND (${!ownClassOnly} OR EXISTS (SELECT 1 FROM club_bookings b
                     WHERE b.club_id = m.club_id AND b.member_id = m.id
                       AND b.occurrence_id = ${request.method === 'desk' ? (request.occurrenceId ?? null) : null}::uuid
                       AND b.state = 'active'))
        `);
        memberId = text(member.rows[0]?.id);
      }
      if (!memberId) return { status: 'not_found' };
      const link = await tx.execute(sql`
        SELECT user_id FROM club_member_links
         WHERE club_id = ${clubId}::uuid AND member_id = ${memberId}::uuid AND status = 'active'
           AND passport_consent_at IS NOT NULL
      `);
      linkUserId = text(link.rows[0]?.user_id);
    }

    // 3. Lock this client's memberships before anything is counted.
    await tx.execute(sql`
      SELECT id FROM club_memberships
       WHERE club_id = ${clubId}::uuid AND member_id = ${memberId}::uuid
       FOR NO KEY UPDATE
    `);

    // 2. The class, and the location.
    const explicitOccurrence =
      request.method === 'desk' || request.method === 'api' ? (request.occurrenceId ?? null) : null;
    const requestedLocation =
      request.method === 'door' ? doorLocation : (request.locationId ?? null);
    // A location named by id — the desk's form, an integration — must be one
    // of THIS club's live ones: a foreign id is a refusal, not a 23503.
    if (requestedLocation && request.method !== 'door') {
      const location = await tx.execute(sql`
        SELECT 1 FROM club_locations
         WHERE id = ${requestedLocation}::uuid AND club_id = ${clubId}::uuid AND active
      `);
      if (location.rows.length === 0) return { status: 'not_found' };
    }
    const occurrence = await tx.execute(sql`
      SELECT o.id, o.starts_at, o.ends_at, k.title, k.sport, k.location_id, k.covers_all_plans,
             k.id AS class_id,
             o.starts_at <= now() + make_interval(mins => ${CHECKIN_EARLY_MINUTES}::int) AS open
        FROM club_class_occurrences o
        JOIN club_classes k ON k.id = o.class_id
       WHERE o.club_id = ${clubId}::uuid AND o.status = 'scheduled'
         AND ${
           explicitOccurrence
             ? sql`o.id = ${explicitOccurrence}::uuid`
             : sql`EXISTS (SELECT 1 FROM club_bookings b
                           WHERE b.occurrence_id = o.id AND b.member_id = ${memberId}::uuid
                             AND b.state = 'active')
                   AND o.starts_at <= now() + make_interval(mins => ${CHECKIN_EARLY_MINUTES}::int)
                   AND o.ends_at > now()
                   ${requestedLocation ? sql`AND k.location_id = ${requestedLocation}::uuid` : sql``}`
         }
       ORDER BY o.starts_at
       LIMIT 1
    `);
    const occ = occurrence.rows[0];
    if (explicitOccurrence && !occ) return { status: 'not_found' };
    // Nobody is present at a class that has not begun: a tick days ahead would
    // spend a visit early. Afterwards the desk may still catch up.
    if (explicitOccurrence && occ && occ.open !== true) return { status: 'too_early' };
    let locationId = occ ? String(occ.location_id) : requestedLocation;
    if (!locationId) {
      const first = await tx.execute(sql`
        SELECT id FROM club_locations WHERE club_id = ${clubId}::uuid AND active
         ORDER BY sort_order, name LIMIT 1
      `);
      locationId = text(first.rows[0]?.id);
    }
    if (!locationId) return { status: 'not_found' };

    // 4. The covering abonnement.
    const member = await tx.execute(sql`
      SELECT display_name, is_minor FROM club_members WHERE id = ${memberId}::uuid
    `);
    const isMinor = member.rows[0]?.is_minor === true;
    const coverage = await tx.execute(sql`
      SELECT b.membership_id, b.plan_name, b.kind, b.visits_remaining,
             to_char(b.effective_ends_on, 'YYYY-MM-DD') AS effective_ends_on
        FROM club_membership_balances b
       WHERE b.club_id = ${clubId}::uuid AND b.member_id = ${memberId}::uuid AND b.state = 'active'
         AND (b.audience = 'all' OR (b.audience = 'minors') = ${isMinor})
         AND ${
           occ && occ.covers_all_plans !== true
             ? sql`EXISTS (SELECT 1 FROM club_class_plans cp
                            WHERE cp.class_id = ${String(occ.class_id)}::uuid AND cp.plan_id = b.plan_id)`
             : sql`TRUE`
         }
       ORDER BY (b.visits_total IS NULL) DESC, b.effective_ends_on, b.membership_id
       LIMIT 1
    `);
    const cover = coverage.rows[0];

    // A door under the 'covered' rule stays shut for a client with nothing
    // that covers this visit — and since nobody came in, nothing is recorded.
    // Unless they are ALREADY in: the scan that let them in may have spent a
    // pack's last visit (the pack is then 'exhausted'), and a second scan for
    // the same class or open-gym day — a slow turnstile, a trip to the car —
    // is the same visit, answered 'already' below.
    const alreadyIn =
      request.method === 'door' && doorRule === 'covered' && !cover
        ? await tx.execute(sql`
            SELECT 1 FROM club_checkins
             WHERE club_id = ${clubId}::uuid AND member_id = ${memberId}::uuid
               AND ${
                 occ
                   ? sql`occurrence_id = ${String(occ.id)}::uuid`
                   : sql`occurrence_id IS NULL AND location_id = ${locationId}::uuid
                         AND sofia_day = (now() AT TIME ZONE 'Europe/Sofia')::date`
               }
          `)
        : null;
    if (alreadyIn !== null && alreadyIn.rows.length === 0) {
      return {
        status: 'denied',
        denial: 'not_covered',
        memberId,
        memberName: String(member.rows[0]?.display_name ?? ''),
        isMinor,
        covered: false,
        membership: null,
      };
    }

    // 5. The record — once per class, once per open-gym day. Nobody at the
    // desk vouched for a kiosk scan, an integration's call or a door.
    const recordedBy =
      request.method === 'qr_kiosk' || request.method === 'api' || request.method === 'door'
        ? null
        : request.actor.userId;
    const inserted = await tx.execute(sql`
      INSERT INTO club_checkins (club_id, member_id, occurrence_id, location_id, method, recorded_by,
                                 consumed_membership_id, covered, sofia_day)
      VALUES (${clubId}::uuid, ${memberId}::uuid, ${occ ? String(occ.id) : null}::uuid,
              ${locationId}::uuid, ${request.method}, ${recordedBy},
              ${cover ? String(cover.membership_id) : null}::uuid, ${Boolean(cover)},
              (now() AT TIME ZONE 'Europe/Sofia')::date)
      ON CONFLICT DO NOTHING
      RETURNING id, sofia_day::text AS sofia_day
    `);
    const membership = cover
      ? {
          planName: String(cover.plan_name),
          kind: String(cover.kind),
          visitsRemaining:
            cover.visits_remaining === null
              ? null
              : Math.max(0, Number(cover.visits_remaining) - (inserted.rows.length > 0 ? 1 : 0)),
          endsOn: String(cover.effective_ends_on),
        }
      : null;
    const base = {
      memberId,
      memberName: String(member.rows[0]?.display_name ?? ''),
      isMinor,
      classTitle: occ ? String(occ.title) : null,
      classStart: occ ? iso(occ.starts_at) : null,
    };
    const row = inserted.rows[0];
    if (!row) {
      const existing = await tx.execute(sql`
        SELECT id FROM club_checkins
         WHERE club_id = ${clubId}::uuid AND member_id = ${memberId}::uuid
           AND ${
             occ
               ? sql`occurrence_id = ${String(occ.id)}::uuid`
               : sql`occurrence_id IS NULL AND location_id = ${locationId}::uuid
                     AND sofia_day = (now() AT TIME ZONE 'Europe/Sofia')::date`
           }
      `);
      return {
        status: 'already',
        checkinId: text(existing.rows[0]?.id) ?? undefined,
        ...base,
        covered: Boolean(cover),
        membership,
        passport: false,
      };
    }
    const checkinId = String(row.id);

    // 6. The passport bridge.
    let passport = false;
    const method: ClubCheckinMethod = request.method;
    if (linkUserId && PASSPORT_CHECKIN_METHODS.includes(method)) {
      const clubSports = club.rows[0]?.sports;
      const rawSport = occ
        ? String(occ.sport)
        : Array.isArray(clubSports) && clubSports.length > 0
          ? String(clubSports[0])
          : 'fitness';
      const sport = isClubSport(rawSport) ? trainingSportFor(rawSport) : 'fitness';
      const durationS = occ
        ? Math.max(
            60,
            Math.min(
              86_400,
              Math.round(
                (new Date(iso(occ.ends_at)).getTime() - new Date(iso(occ.starts_at)).getTime()) /
                  1000,
              ),
            ),
          )
        : OPEN_GYM_MINUTES * 60;
      const log = await tx.execute(sql`
        INSERT INTO training_logs (user_id, sport, started_at, sofia_day, duration_s, facility_id,
                                   municipality_id, source, evidence, external_id)
        SELECT ${linkUserId}, ${sport}, ${occ ? iso(occ.starts_at) : sql`now()`}::timestamptz,
               ${String(row.sofia_day)}::date, ${durationS}, l.facility_id,
               coalesce(f.municipality_id, c.municipality_id), 'club', 'qr_verified', ${checkinId}
          FROM club_locations l
          JOIN clubs c ON c.id = l.club_id
          LEFT JOIN facilities f ON f.id = l.facility_id
         WHERE l.id = ${locationId}::uuid
        ON CONFLICT (user_id, source, external_id) WHERE external_id IS NOT NULL DO NOTHING
        RETURNING id
      `);
      const logId = text(log.rows[0]?.id);
      if (logId) {
        await tx.execute(sql`
          UPDATE club_checkins SET training_log_id = ${logId}::uuid WHERE id = ${checkinId}::uuid
        `);
        passport = true;
      }
    }

    await recordClubAudit(tx, {
      clubId,
      by:
        request.method === 'qr_kiosk'
          ? { kind: 'member', userId: request.userId }
          : request.method === 'door'
            ? { kind: 'door', deviceId: request.deviceId }
            : { kind: 'staff', actor: request.actor },
      action: 'checkin_recorded',
      subjectMemberId: memberId,
      detail: { method, covered: Boolean(cover), passport },
    });
    return {
      status: 'recorded',
      checkinId,
      ...base,
      covered: Boolean(cover),
      membership,
      passport,
    };
  });
}

export interface TodayCheckin {
  id: string;
  memberId: string;
  displayName: string;
  isMinor: boolean;
  method: ClubCheckinMethod;
  covered: boolean;
  at: string;
  classTitle: string | null;
  locationName: string;
  planName: string | null;
  visitsRemaining: number | null;
  endsOn: IsoDate | null;
}

/**
 * Today's arrivals (Sofia day), newest first, for the desk screen. Front of
 * house only: the coverage and abonnement columns are the desk's business.
 */
export async function todaysCheckins(actor: ClubActor, limit = 200): Promise<TodayCheckin[]> {
  const result = await getDb().execute(sql`
    SELECT ci.id, ci.member_id, m.display_name, m.is_minor, ci.method, ci.covered, ci.checked_in_at,
           k.title AS class_title, l.name AS location_name,
           mb.plan_name, mb.visits_remaining, to_char(mb.effective_ends_on, 'YYYY-MM-DD') AS ends_on
      FROM club_checkins ci
      JOIN club_members m ON m.club_id = ci.club_id AND m.id = ci.member_id
      JOIN club_locations l ON l.club_id = ci.club_id AND l.id = ci.location_id
      LEFT JOIN club_class_occurrences o ON o.club_id = ci.club_id AND o.id = ci.occurrence_id
      LEFT JOIN club_classes k ON k.id = o.class_id
      LEFT JOIN club_membership_balances mb
             ON mb.club_id = ci.club_id AND mb.membership_id = ci.consumed_membership_id
     WHERE ${clubScope(actor, 'attendance.record', 'ci')}
       AND ci.sofia_day = (now() AT TIME ZONE 'Europe/Sofia')::date
     ORDER BY ci.checked_in_at DESC
     LIMIT ${limit}
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    memberId: String(row.member_id),
    displayName: String(row.display_name),
    isMinor: row.is_minor === true,
    method: String(row.method) as ClubCheckinMethod,
    covered: row.covered === true,
    at: iso(row.checked_in_at),
    classTitle: text(row.class_title),
    locationName: String(row.location_name),
    planName: text(row.plan_name),
    visitsRemaining: row.visits_remaining === null ? null : Number(row.visits_remaining),
    endsOn: text(row.ends_on),
  }));
}

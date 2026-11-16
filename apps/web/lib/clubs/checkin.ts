import { getDb, sql, type SQL } from '@sportkarta/db';
import {
  PASSPORT_CHECKIN_METHODS,
  isClubSport,
  trainingSportFor,
  type ClubCheckinMethod,
  type IsoDate,
} from '@sportkarta/lib/clubs';
import { sha256Hex } from '@sportkarta/lib/clubs/secrets';

import { SOFIA_TODAY_SQL, clubWritableSql } from './access';
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
 *      at this location that is about to start or running — one not ticked
 *      yet before one that is, so somebody booked into two classes back to
 *      back is ticked into the second by their second scan — else none: an
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
 * ONE ARRIVAL, ONE ROW, ONE VISIT. The desk ticking a walk-in and the trainer
 * ticking the roster are the same person coming through the same door once,
 * so they must not spend two visits of a card:
 *   - a class tick for somebody who already has the open-gym row of THE
 *     CLASS'S DAY at the class's location takes that row over (its occurrence
 *     is set) instead of adding a second. The visit stays where it was when
 *     that abonnement covers the class too; it moves to the one that does
 *     when the class accepts only certain plans; and when the hall visit was
 *     paid and nothing covers the class, the two stay apart — a paid hall
 *     visit and an unpaid class — so neither truth is lost;
 *   - an open-gym tick for somebody already ticked into a class of TODAY at
 *     that location answers 'already'.
 * The day is the class's own (Sofia), never the day of the tick: the desk
 * catching up on yesterday's roster today is not today's arrival. A row taken
 * over by a scan becomes a scan (method, recorded_by), which is what lets it
 * reach the passport; the diary entry an earlier scan already wrote is the
 * member's own and is left as it is.
 *
 * NEVER A REFUSAL. An expired, exhausted or unpaid client is RECORDED with
 * covered = false and the desk is told so in words (0014's principle). The
 * one exception is a DOOR, which may stay shut — and then records nothing:
 * under 'covered' for a client nothing covers, and under either rule for a
 * record its holder made for themselves (a trial, an inquiry, a court booked
 * online) that the club has never handled — no abonnement ever sold to it,
 * no card issued. Signing up on the club's page is not being let in. A door
 * never locks out somebody who is already in today.
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
    let doorStranger = false;
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
      // `stranger`: a record its holder made for themselves (ensureSelfRecord:
      // a trial, an inquiry, an online booking) that the club has never
      // handled — a «lead» by the module's one definition (club_member_status:
      // no abonnement ever sold to it) with no card issued by the desk. A
      // client the desk keeps is never one, with or without an abonnement.
      const found = await tx.execute(sql`
        SELECT m.id, m.display_name, m.archived_at,
               (m.source = 'self' AND m.card_token_hash IS NULL
                AND EXISTS (SELECT 1 FROM club_member_status st
                             WHERE st.club_id = m.club_id AND st.member_id = m.id
                               AND st.status = 'lead')) AS stranger
          FROM club_members m
         WHERE m.club_id = ${clubId}::uuid
           AND ${
             credential.kind === 'card'
               ? sql`m.card_token_hash = ${sha256Hex(credential.cardKey)}`
               : sql`m.id = ${credential.memberId}::uuid`
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
      doorStranger = record.stranger === true;
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
    // Among the client's bookings that are "now", one not ticked yet comes
    // first: the earliest alone would answer 'already' for the first of two
    // classes back to back until it ended, and never reach the second.
    const occurrence = await tx.execute(sql`
      SELECT o.id, o.starts_at, o.ends_at, k.title, k.sport, k.location_id, k.covers_all_plans,
             k.id AS class_id,
             o.starts_at <= now() + make_interval(mins => ${CHECKIN_EARLY_MINUTES}::int) AS open,
             to_char(o.starts_at AT TIME ZONE 'Europe/Sofia', 'YYYY-MM-DD') AS sofia_day
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
       ORDER BY EXISTS (SELECT 1 FROM club_checkins seen
                         WHERE seen.club_id = o.club_id AND seen.occurrence_id = o.id
                           AND seen.member_id = ${memberId}::uuid),
                o.starts_at
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

    const base = {
      memberId,
      memberName: String(member.rows[0]?.display_name ?? ''),
      isMinor,
      classTitle: occ ? String(occ.title) : null,
      classStart: occ ? iso(occ.starts_at) : null,
    };
    /** An abonnement as the desk is told of it; `spent` when this tick takes a visit of it. */
    const describe = (
      balance: Record<string, unknown> | undefined,
      spent: boolean,
    ): CheckinOutcome['membership'] =>
      balance
        ? {
            planName: String(balance.plan_name),
            kind: String(balance.kind),
            visitsRemaining:
              balance.visits_remaining === null
                ? null
                : Math.max(0, Number(balance.visits_remaining) - (spent ? 1 : 0)),
            endsOn: String(balance.effective_ends_on),
          }
        : null;
    const already = (checkinId: string | null): CheckinOutcome => ({
      status: 'already',
      checkinId: checkinId ?? undefined,
      ...base,
      covered: Boolean(cover),
      membership: describe(cover, false),
      passport: false,
    });

    // 5. The record — once per class, once per arrival (see the header).
    // First, what is on the books already.
    /** The client's row for one class. */
    const rowOfClass = async (occurrenceId: string): Promise<string | null> => {
      const found = await tx.execute(sql`
        SELECT id FROM club_checkins
         WHERE club_id = ${clubId}::uuid AND member_id = ${memberId}::uuid
           AND occurrence_id = ${occurrenceId}::uuid
      `);
      return text(found.rows[0]?.id);
    };
    /**
     * The client's arrival TODAY at this location: the open-gym row, or the
     * row of a class that is today's — by the class's own day, since a late
     * tick for an older class is recorded today without being today's visit.
     */
    const rowOfToday = async (): Promise<string | null> => {
      const found = await tx.execute(sql`
        SELECT ci.id FROM club_checkins ci
          LEFT JOIN club_class_occurrences co
                 ON co.club_id = ci.club_id AND co.id = ci.occurrence_id
         WHERE ci.club_id = ${clubId}::uuid AND ci.member_id = ${memberId}::uuid
           AND ci.location_id = ${locationId}::uuid
           AND CASE WHEN ci.occurrence_id IS NULL THEN ci.sofia_day = ${SOFIA_TODAY_SQL}
                    ELSE (co.starts_at AT TIME ZONE 'Europe/Sofia')::date = ${SOFIA_TODAY_SQL} END
         ORDER BY ci.checked_in_at DESC, ci.id
         LIMIT 1
      `);
      return text(found.rows[0]?.id);
    };
    const existingId = occ ? await rowOfClass(String(occ.id)) : await rowOfToday();

    // A door may stay shut: under 'covered' for a client with nothing that
    // covers this visit, under either rule for a record the club has never
    // handled — and since nobody came in, nothing is recorded. Unless they
    // are ALREADY in today: the scan that let them in may have spent a pack's
    // last visit (the pack is then 'exhausted'), and a second scan — a slow
    // turnstile, a trip to the car, a next class the spent card does not
    // cover — opens the door for the visit they are on and records nothing
    // new.
    if (request.method === 'door' && ((doorRule === 'covered' && !cover) || doorStranger)) {
      const inside = existingId ?? (occ ? await rowOfToday() : null);
      if (!inside) {
        return {
          status: 'denied',
          denial: 'not_covered',
          memberId,
          memberName: base.memberName,
          isMinor,
          covered: false,
          membership: null,
        };
      }
      // Let through on another row than this class's: the class is not ticked.
      return inside === existingId
        ? already(inside)
        : { ...already(inside), classTitle: null, classStart: null };
    }
    if (existingId) return already(existingId);

    // Nobody at the desk vouched for a kiosk scan, an integration's call or a
    // door.
    const recordedBy =
      request.method === 'qr_kiosk' || request.method === 'api' || request.method === 'door'
        ? null
        : request.actor.userId;
    const method: ClubCheckinMethod = request.method;
    const scanned = PASSPORT_CHECKIN_METHODS.includes(method);

    let checkinId: string | null = null;
    let sofiaDay = '';
    let covered = Boolean(cover);
    let membership = describe(cover, true);
    let joined = false;
    let hasLog = false;

    // A class tick takes over the open-gym row of the class's day here, when
    // there is one: the same arrival (see the header). Locked, so a second
    // tick arriving with this one finds the row already a class row.
    if (occ) {
      const open = await tx.execute(sql`
        SELECT ci.id, ci.method, ci.consumed_membership_id, ci.covered, ci.training_log_id,
               ci.sofia_day::text AS sofia_day,
               EXISTS (SELECT 1 FROM club_memberships ms
                        WHERE ms.club_id = ci.club_id AND ms.id = ci.consumed_membership_id
                          AND (${occ.covers_all_plans === true}
                               OR EXISTS (SELECT 1 FROM club_class_plans cp
                                           WHERE cp.class_id = ${String(occ.class_id)}::uuid
                                             AND cp.plan_id = ms.plan_id))) AS keeps
          FROM club_checkins ci
         WHERE ci.club_id = ${clubId}::uuid AND ci.member_id = ${memberId}::uuid
           AND ci.occurrence_id IS NULL AND ci.location_id = ${locationId}::uuid
           AND ci.sofia_day = ${String(occ.sofia_day)}::date
           FOR UPDATE OF ci
      `);
      const arrival = open.rows[0];
      // The visit stays on the abonnement it was counted against when that
      // one covers the class too; else it moves to the one that does. A paid
      // hall visit and a class nothing covers stay two rows: joining them
      // would either hand the visit back or call the class paid.
      const keeps = arrival?.keeps === true;
      const apart = !keeps && !cover && arrival?.covered === true;
      if (arrival && !apart) {
        const paidBy = keeps
          ? String(arrival.consumed_membership_id)
          : cover
            ? String(cover.membership_id)
            : null;
        // Taken over by a scan, the row is a scan: that is what the passport
        // bridge (and its database guard) asks of a check-in.
        const becomesScan =
          scanned &&
          !PASSPORT_CHECKIN_METHODS.includes(String(arrival.method) as ClubCheckinMethod);
        const taken = await tx.execute(sql`
          UPDATE club_checkins ci
             SET occurrence_id = ${String(occ.id)}::uuid,
                 consumed_membership_id = ${paidBy}::uuid, covered = ${paidBy !== null}
                 ${becomesScan ? sql`, method = ${method}, recorded_by = ${recordedBy}` : sql``}
           WHERE ci.id = ${String(arrival.id)}::uuid AND ci.occurrence_id IS NULL
          RETURNING ci.id
        `);
        if (taken.rows.length > 0) {
          checkinId = String(arrival.id);
          sofiaDay = String(arrival.sofia_day);
          covered = paidBy !== null;
          joined = true;
          hasLog = arrival.training_log_id !== null && arrival.training_log_id !== undefined;
          if (keeps) {
            // No new visit: the one already counted stands.
            const kept = await tx.execute(sql`
              SELECT b.plan_name, b.kind, b.visits_remaining,
                     to_char(b.effective_ends_on, 'YYYY-MM-DD') AS effective_ends_on
                FROM club_membership_balances b
               WHERE b.club_id = ${clubId}::uuid AND b.membership_id = ${paidBy}::uuid
            `);
            membership = describe(kept.rows[0], false);
          }
        }
      }
    }

    if (checkinId === null) {
      const inserted = await tx.execute(sql`
        INSERT INTO club_checkins (club_id, member_id, occurrence_id, location_id, method, recorded_by,
                                   consumed_membership_id, covered, sofia_day)
        VALUES (${clubId}::uuid, ${memberId}::uuid, ${occ ? String(occ.id) : null}::uuid,
                ${locationId}::uuid, ${request.method}, ${recordedBy},
                ${cover ? String(cover.membership_id) : null}::uuid, ${Boolean(cover)},
                ${SOFIA_TODAY_SQL})
        ON CONFLICT DO NOTHING
        RETURNING id, sofia_day::text AS sofia_day
      `);
      const row = inserted.rows[0];
      // The same tick, a moment earlier, on another connection.
      if (!row) return already(occ ? await rowOfClass(String(occ.id)) : await rowOfToday());
      checkinId = String(row.id);
      sofiaDay = String(row.sofia_day);
    }

    // 6. The passport bridge. A row that already carries a diary entry — an
    // earlier scan's — keeps that one.
    let passport = false;
    if (linkUserId && scanned && !hasLog) {
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
               ${sofiaDay}::date, ${durationS}, l.facility_id,
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
      detail: { method, covered, passport, ...(joined ? { joined: true } : {}) },
    });
    return {
      status: 'recorded',
      checkinId,
      ...base,
      covered,
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

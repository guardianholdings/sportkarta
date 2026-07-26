import { sql, type SQL } from '@sportkarta/db';
import { verifyCheckinToken } from '@sportkarta/lib/checkin-token';
import { ATTENDANCE_AWARDS_PER_DAY, awardKey, POINTS_BY_EVENT } from '@sportkarta/lib/points';

import { SessionError } from './errors';

/**
 * Attendance check-in and its scoring (docs/ROADMAP.md §6 Stage 4.1, §7 Stage 5.4).
 *
 * Three methods:
 *  - `self`      the member taps "I am here". Recorded, never scored.
 *  - `organizer` the organiser marks somebody present. Recorded, never scored.
 *  - `qr`        the member redeems a signed, expiring token from the
 *                organiser's screen. Recorded, and the only one that scores.
 *
 * AUTHORIZATION IS STILL THE POINT OF THIS FILE. A check-in row is a claim that
 * a named person was at a place at a time, and it is now worth points, so
 * writing one for somebody else must not be possible:
 *
 *  - `self` may only ever be written by the person themselves.
 *  - `organizer` may only be written by the organiser of THAT series, checked
 *    against the database in the same statement.
 *  - `qr` is authorised by the token, and the token names the OCCURRENCE, never
 *    a member — it is displayed once to everybody in the park. Who is checked
 *    in is decided by the session cookie on the request that redeems it.
 *
 * The time window is evaluated in SQL against `now()` rather than against the
 * application's clock, so skew between the web container and the database
 * cannot open check-in early or hold it open late.
 *
 * ── WHAT VERIFICATION IS AND IS NOT (Stage 5.4) ────────────────────────────
 *
 * The honest statement, because a dishonest one here would be worse than no
 * feature at all:
 *
 *   The QR token proves that somebody could read the organiser's screen within
 *   the last two minutes. It does not prove who. The geofence uses coordinates
 *   the BROWSER supplied, which any determined person can fake in about a
 *   minute. Neither is proof of attendance and this file does not pretend
 *   otherwise.
 *
 * What they are is a cost: to farm attendance points you must obtain a fresh
 * token every two minutes from a session you are not at, and lie about your
 * location, for two points a time, capped at three a day. That is dramatically
 * more effort than the reward, which is the whole of "proportionate". The
 * alternative designs — a device identifier, background location, a photo —
 * all collect far more about children than the problem justifies.
 *
 * ANTI-ABUSE, IN FULL:
 *   1. Only `qr` scores, enforced by a CHECK (play_session_checkins_only_qr_scores).
 *   2. The token expires in one to two minutes and is bound to the occurrence.
 *   3. One award per member per occurrence, ever — the ledger's idempotency key.
 *   4. At most ATTENDANCE_AWARDS_PER_DAY awards per Sofia day.
 *   5. Out of range, or no location offered, records the attendance and pays
 *      nothing.
 * Nothing on that list REFUSES a check-in. Attendance is a fact and is always
 * recorded; only the payment stops. That is deliberate: an anti-abuse rule that
 * can wrongly erase a child's attendance is worse than one that can wrongly
 * decline to pay them two points, and there is an appeal path for the second
 * (an ambassador can see the row) but none for the first.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

export type CheckinMethod = 'self' | 'organizer' | 'qr';

/** Doors open half an hour early… */
export const CHECKIN_OPENS_BEFORE_MINUTES = 30;
/** …and close two hours after the end, so a late arrival is still recorded. */
export const CHECKIN_CLOSES_AFTER_MINUTES = 120;

/**
 * How close is close enough, in metres.
 *
 * Generously wide on purpose. Urban GPS is routinely 50 m out between tower
 * blocks, and a park's registered point is often its gate rather than the pitch
 * somebody is standing on. A tight radius would not stop anybody willing to
 * fake a coordinate — it would only fail honest members standing in the wrong
 * corner, which is the one failure this feature cannot afford.
 */
export const GEOFENCE_RADIUS_M = 250;

/**
 * The check-in window, as one SQL fragment used by every statement that asks
 * the question — here and in the roster's gate — so the two can never drift.
 * Evaluated against the DATABASE's `now()`, never the application clock, and
 * expects the occurrence aliased as `o`.
 */
export function checkinWindowSql() {
  return sql`(o.starts_at - make_interval(mins => ${CHECKIN_OPENS_BEFORE_MINUTES}) <= now()
              AND o.ends_at + make_interval(mins => ${CHECKIN_CLOSES_AFTER_MINUTES}) >= now())`;
}

/**
 * The largest distance that is ever WRITTEN, matching the column's CHECK.
 *
 * A constraint must never be the thing that decides whether an attendance is
 * recorded, so the query clamps rather than letting a wild reading raise
 * SQLSTATE 23514 and abort the transaction. Wild readings are routine: a
 * desktop browser falling back to an IP-derived fix can be a continent away.
 * Anything at this bound is hundreds of kilometres outside the geofence, so
 * clamping changes no decision — it only keeps the row writable.
 */
export const MAX_RECORDED_DISTANCE_M = 1_000_000;

export interface CheckinInput {
  occurrenceId: string;
  /** Who is being recorded as present. */
  userId: string;
  /** Who is making the request. */
  actorId: string;
  method?: CheckinMethod;
  /** Required for `qr`; verified against the secret before anything is written. */
  token?: string;
  /** The browser's reading. Used for one statement and never stored. */
  lat?: number | null;
  lon?: number | null;
  /** HMAC secret; absent disables QR check-in entirely (fail closed). */
  secret?: string | undefined;
  now?: Date;
}

/** Why an attendance did not earn points. `scored` means it did. */
export type CheckinOutcome =
  | 'scored'
  | 'unscored_method'
  | 'unscored_no_location'
  | 'unscored_out_of_range'
  | 'unscored_daily_cap'
  | 'unscored_already';

export interface CheckinResult {
  checkinId: string;
  /** False when the person was already checked in — the call is idempotent. */
  created: boolean;
  outcome: CheckinOutcome;
  /** Metres from the facility, when a location was offered. */
  distanceM: number | null;
  pointsAwarded: number;
}

export async function checkIn(db: TransactionalDb, input: CheckinInput): Promise<CheckinResult> {
  const method = input.method ?? 'self';
  if (method !== 'self' && method !== 'organizer' && method !== 'qr') {
    throw new SessionError('invalid_checkin_method');
  }
  // Checking someone else in is an organiser action, by definition — and a QR
  // is redeemed by whoever scanned it, so it is always first-person too.
  if (method !== 'organizer' && input.actorId !== input.userId) {
    throw new SessionError('not_organizer');
  }

  if (method === 'qr') {
    // Fail closed: with no secret configured, no token can be valid, so QR
    // check-in is simply unavailable rather than universally accepted.
    const verified = verifyCheckinToken(input.token ?? '', input.secret ?? '', input.now);
    if (!verified.ok) throw new SessionError('invalid_checkin_token');
    // The token names the occurrence, so a valid token for LAST week's session
    // cannot be redeemed against this one.
    if (verified.occurrenceId !== input.occurrenceId) {
      throw new SessionError('invalid_checkin_token');
    }
  }

  return db.transaction(async (tx) => {
    // One statement for the whole decision: the occurrence's state, the actor's
    // authority, the window, and — when coordinates were offered — the distance
    // from the facility. PostGIS computes it on the geography type, so the
    // answer is metres on the ellipsoid rather than degrees.
    const context = await tx.execute(sql`
      SELECT o.status,
             ${checkinWindowSql()} AS within_window,
             (s.organizer_id = ${input.actorId}) AS actor_is_organizer,
             -- Only consulted for method='organizer': a vouch may name ONLY a
             -- member on the occurrence's own roster. Without this, an
             -- organizer could write "this named person was here" for ANY
             -- account id in the system — rows that flow into the victim's
             -- passport history, streaks and badges. Method 'self' stays
             -- first-person and 'qr' is redeemed by whoever scanned it, so
             -- neither needs it.
             EXISTS (SELECT 1 FROM play_session_rsvps r
                      WHERE r.occurrence_id = o.id
                        AND r.user_id = ${input.userId}
                        AND r.state = 'active') AS member_attending,
             s.facility_id,
             CASE WHEN ${input.lat ?? null}::float8 IS NULL OR ${input.lon ?? null}::float8 IS NULL
                  THEN NULL
                  -- CLAMPED, and the clamp is load-bearing. distance_m is
                  -- CHECK-bounded at 1 000 km; a desktop browser falling back
                  -- to an IP-derived fix in Frankfurt is ~1 450 km from Sofia,
                  -- and a spoofed coordinate can be 20 000 km. Unclamped, that
                  -- raises a constraint violation, aborts this transaction, and
                  -- records NO ATTENDANCE AT ALL — which is precisely the
                  -- failure this whole design refuses (attendance is a fact; it
                  -- is the payment that stops). Well past the geofence either
                  -- way, so the outcome is unchanged: recorded, unpaid.
                  ELSE least(
                         round(ST_Distance(
                           f.geom::geography,
                           ST_SetSRID(ST_MakePoint(${input.lon ?? null}::float8,
                                                   ${input.lat ?? null}::float8), 4326)::geography
                         ))::int,
                         ${MAX_RECORDED_DISTANCE_M}
                       )
             END AS distance_m
        FROM play_session_occurrences o
        JOIN play_sessions s ON s.id = o.session_id
        JOIN facilities f ON f.id = s.facility_id
       WHERE o.id = ${input.occurrenceId}::uuid
    `);
    const row = context.rows[0];
    if (!row) throw new SessionError('occurrence_not_found');
    if (row.status === 'cancelled') throw new SessionError('occurrence_cancelled');
    if (method === 'organizer' && row.actor_is_organizer !== true) {
      throw new SessionError('not_organizer');
    }
    if (method === 'organizer' && row.member_attending !== true) {
      throw new SessionError('not_attending');
    }
    if (row.within_window !== true) throw new SessionError('checkin_window_closed');

    const facilityId = String(row.facility_id);
    const distanceM =
      row.distance_m === null || row.distance_m === undefined ? null : Number(row.distance_m);

    const outcome = await decideOutcome(tx, { method, distanceM, userId: input.userId });
    const scored = outcome === 'scored';

    // Idempotent by (occurrence_id, user_id): a double tap, a retried request or
    // two people marking the same person converge on one attendance.
    const inserted = await tx.execute(sql`
      INSERT INTO play_session_checkins
        (occurrence_id, user_id, method, recorded_by, distance_m, scored)
      VALUES (${input.occurrenceId}::uuid, ${input.userId},
              ${method}::play_session_checkin_method,
              ${method === 'organizer' ? input.actorId : null},
              ${distanceM}, ${scored})
      ON CONFLICT (occurrence_id, user_id) DO NOTHING
      RETURNING id
    `);

    if (inserted.rows.length === 0) {
      // Already there. Do NOT re-run the award: the ledger key would refuse it
      // anyway, but reporting it as freshly scored would be a lie to the UI.
      const existing = await tx.execute(sql`
        SELECT id FROM play_session_checkins
         WHERE occurrence_id = ${input.occurrenceId}::uuid AND user_id = ${input.userId}
      `);
      return {
        checkinId: String(existing.rows[0]?.id),
        created: false,
        outcome: 'unscored_already' as const,
        distanceM,
        pointsAwarded: 0,
      };
    }

    const checkinId = String(inserted.rows[0]?.id);
    let pointsAwarded = 0;
    if (scored) {
      pointsAwarded = await award(tx, {
        userId: input.userId,
        facilityId,
        occurrenceId: input.occurrenceId,
      });
    }

    return { checkinId, created: true, outcome, distanceM, pointsAwarded };
  });
}

/**
 * The scoring decision, in order, so the reason reported to the member is the
 * FIRST thing that was wrong rather than the last one checked.
 */
async function decideOutcome(
  db: SqlRunner,
  input: { method: CheckinMethod; distanceM: number | null; userId: string },
): Promise<CheckinOutcome> {
  if (input.method !== 'qr') return 'unscored_method';
  if (input.distanceM === null) return 'unscored_no_location';
  if (input.distanceM > GEOFENCE_RADIUS_M) return 'unscored_out_of_range';

  // The daily cap, counted over the ledger in CIVIL Sofia days — the same day
  // boundary every other rule in the product uses, so a session that starts at
  // 23:30 belongs to the day it started on rather than to UTC's idea of it.
  //
  // COUNTED WITHOUT A LOCK, deliberately. Two check-ins racing in the same
  // instant can both read n = 2 and both score, putting four awards in a day
  // against a cap of three. That is bounded (you cannot be in two places at
  // once often), cheap, and self-limiting — and the alternative, serialising
  // every check-in of every member through a row lock, would make the busiest
  // moment of the product (a whole team scanning at once) the slowest. The cap
  // is a brake on farming, not an accounting invariant; the invariant that
  // matters is one award per occurrence, and that one IS enforced, by the
  // ledger's unique key.
  const today = await db.execute(sql`
    SELECT count(*)::int AS n
      FROM points_ledger
     WHERE user_id = ${input.userId}
       AND event = 'session_attended'
       AND (created_at AT TIME ZONE 'Europe/Sofia')::date
           = (now() AT TIME ZONE 'Europe/Sofia')::date
  `);
  const awardedToday = Number(today.rows[0]?.n ?? 0);
  if (awardedToday >= ATTENDANCE_AWARDS_PER_DAY) return 'unscored_daily_cap';

  return 'scored';
}

/**
 * Write the award. `ON CONFLICT DO NOTHING` on the idempotency key, inside the
 * check-in's own transaction, exactly as the Stage 3.2 contribution flows do —
 * so a retry cannot double-award and a failed award cannot leave a check-in
 * marked `scored` with no ledger row behind it.
 */
async function award(
  db: SqlRunner,
  input: { userId: string; facilityId: string; occurrenceId: string },
): Promise<number> {
  const points = POINTS_BY_EVENT.session_attended;
  const key = awardKey({
    event: 'session_attended',
    facilityId: input.facilityId,
    userId: input.userId,
    occurrenceId: input.occurrenceId,
  });
  const result = await db.execute(sql`
    INSERT INTO points_ledger (user_id, event, points, facility_id, idempotency_key)
    VALUES (${input.userId}, 'session_attended', ${points}, ${input.facilityId}::uuid, ${key})
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING points
  `);
  return result.rows.length > 0 ? points : 0;
}

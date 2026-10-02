import { sql } from '@sportkarta/db';
import { issueCheckinToken } from '@sportkarta/lib/checkin-token';
import { POINTS_BY_EVENT } from '@sportkarta/lib/points';
import { afterAll, describe, expect, it } from 'vitest';

import { checkIn } from '@/lib/sessions/checkin';
import { attendanceCounts, rsvp, withdraw } from '@/lib/sessions/rsvp';
import { createSession } from '@/lib/sessions/sessions';

import {
  aFacility,
  closePool,
  FAR_AWAY,
  firstOccurrence,
  hasDb,
  journey,
  makeUser,
  one,
  sofiaWallClock,
  type Tx,
} from './db';

/**
 * RSVP, waitlist and attendance (Stages 4.1 and 5.4), through the real
 * functions against real PostGIS. The statement-level companion is
 * tests/sessions.test.ts; db/src/sessions-*.test.ts prove the constraints with
 * hand-written statements. This is the one that runs the app's own SQL.
 */

const SECRET = 'journey-check-in-secret-of-more-than-32-chars';

/**
 * A one-off session starting ten minutes from the database's now(): still
 * open for RSVPs (0008 refuses a started occurrence), already inside the
 * check-in window, which opens half an hour early. Relative, never a date.
 */
async function sessionStartingSoon(
  tx: Tx,
  organizerId: string,
  capacity: number | null,
): Promise<{ occurrenceId: string; facility: { id: string; lat: number; lon: number } }> {
  const facility = await aFacility(tx);
  const { sessionId } = await createSession(tx, organizerId, {
    facilityId: facility.id,
    sport: 'basketball',
    title: 'Journey pickup game',
    startsAtLocal: await sofiaWallClock(tx, '10 minutes'),
    durationMinutes: 90,
    capacity,
  });
  return { occurrenceId: await firstOccurrence(tx, sessionId), facility };
}

describe.skipIf(!hasDb)('session journeys (requires running database)', () => {
  afterAll(closePool);

  it('queues by arrival, promotes on a withdrawal and says who was promoted', async () => {
    await journey(async (tx) => {
      const organizer = await makeUser(tx, 'organizer');
      const first = await makeUser(tx, 'first');
      const second = await makeUser(tx, 'second');
      const { occurrenceId } = await sessionStartingSoon(tx, organizer, 1);

      const joined = await rsvp(tx, first, occurrenceId);
      expect(joined).toMatchObject({ status: 'going', position: 1, joined: true });
      // A double-submitted form is the same sign-up: same ticket, no second
      // confirmation email.
      expect(await rsvp(tx, first, occurrenceId)).toMatchObject({
        status: 'going',
        position: 1,
        joined: false,
        seq: joined.seq,
      });
      expect(await rsvp(tx, second, occurrenceId)).toMatchObject({
        status: 'waitlisted',
        position: 2,
        joined: true,
      });
      expect(await attendanceCounts(tx, occurrenceId)).toEqual({
        going: 1,
        waitlisted: 1,
        capacity: 1,
      });

      // Promotion is arithmetic; withdraw() is what names the person to tell.
      expect(await withdraw(tx, first, occurrenceId)).toEqual({ promoted: [second] });
      expect(await attendanceCounts(tx, occurrenceId)).toEqual({
        going: 1,
        waitlisted: 0,
        capacity: 1,
      });
      await expect(withdraw(tx, first, occurrenceId)).rejects.toMatchObject({
        code: 'not_attending',
      });

      // Coming back is a fresh ticket at the back of the queue.
      const rejoined = await rsvp(tx, first, occurrenceId);
      expect(rejoined).toMatchObject({ status: 'waitlisted', position: 2, joined: true });
      expect(rejoined.seq).toBeGreaterThan(joined.seq);
    });
  });

  it('pays a QR check-in at the facility once, and records every other attendance unpaid', async () => {
    await journey(async (tx) => {
      const organizer = await makeUser(tx, 'host');
      const player = await makeUser(tx, 'player');
      const wanderer = await makeUser(tx, 'wanderer');
      const stranger = await makeUser(tx, 'stranger');
      const { occurrenceId, facility } = await sessionStartingSoon(tx, organizer, null);
      await rsvp(tx, player, occurrenceId);

      const atTheFacility = { lat: facility.lat, lon: facility.lon };
      const scan = (userId: string, where: { lat: number; lon: number }, secret = SECRET) =>
        checkIn(tx, {
          occurrenceId,
          userId,
          actorId: userId,
          method: 'qr',
          token: issueCheckinToken({ occurrenceId, secret }),
          secret: SECRET,
          ...where,
        });

      expect(await scan(player, atTheFacility)).toMatchObject({
        created: true,
        outcome: 'scored',
        distanceM: 0,
        pointsAwarded: POINTS_BY_EVENT.session_attended,
      });
      // Scanning again: recorded once, paid once.
      expect(await scan(player, atTheFacility)).toMatchObject({
        created: false,
        outcome: 'unscored_already',
        pointsAwarded: 0,
      });
      const paid = await one<{ n: number; total: number }>(
        tx,
        sql`SELECT count(*)::int AS n, coalesce(sum(points), 0)::int AS total
              FROM points_ledger
             WHERE idempotency_key = ${`session_attended:${occurrenceId}:${player}`}`,
      );
      expect(paid).toEqual({ n: 1, total: POINTS_BY_EVENT.session_attended });

      // From another city the attendance is still a fact — only the payment
      // stops (0014: nothing in the anti-abuse layer refuses a check-in).
      expect(await scan(wanderer, FAR_AWAY)).toMatchObject({
        created: true,
        outcome: 'unscored_out_of_range',
        pointsAwarded: 0,
      });
      const recorded = await tx.execute(
        sql`SELECT user_id, method, scored, distance_m > 250 AS far
              FROM play_session_checkins WHERE occurrence_id = ${occurrenceId}::uuid
             ORDER BY checked_in_at, user_id`,
      );
      expect(recorded.rows).toHaveLength(2);
      expect(recorded.rows).toEqual(
        expect.arrayContaining([
          { user_id: player, method: 'qr', scored: true, far: false },
          { user_id: wanderer, method: 'qr', scored: false, far: true },
        ]),
      );

      // A token signed with anything but the secret is refused before any
      // write, and an organiser cannot vouch for somebody not on the roster.
      await expect(scan(stranger, atTheFacility, `${SECRET}-forged`)).rejects.toMatchObject({
        code: 'invalid_checkin_token',
      });
      await expect(
        checkIn(tx, { occurrenceId, userId: stranger, actorId: organizer, method: 'organizer' }),
      ).rejects.toMatchObject({ code: 'not_attending' });
      const strangers = await one<{ n: number }>(
        tx,
        sql`SELECT count(*)::int AS n FROM play_session_checkins WHERE user_id = ${stranger}`,
      );
      expect(strangers?.n).toBe(0);
    });
  });
});

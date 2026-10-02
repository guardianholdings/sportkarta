import { sql } from '@sportkarta/db';
import { afterAll, describe, expect, it } from 'vitest';

import { deleteAccount, SESSION_NOTIFY_QUEUE } from '@/lib/account-deletion';
import { addFacility } from '@/lib/contributions/add-facility';
import { rsvp } from '@/lib/sessions/rsvp';
import { createSession } from '@/lib/sessions/sessions';

import {
  aFacility,
  closePool,
  emailOf,
  firstOccurrence,
  hasDb,
  journey,
  makeUser,
  one,
  sofiaPin,
  sofiaWallClock,
  type Tx,
} from './db';

/**
 * GDPR self-service erasure (docs/ROADMAP.md §5), through the real
 * deleteAccount() against real PostGIS, after the account has done the
 * things members do. db/src/auth-erasure.test.ts proves the cascades with
 * hand-written statements; this proves the function the profile page calls.
 */

/** A weekly series starting tomorrow, organised by `organizerId`, with its first occurrence. */
async function weeklySeries(tx: Tx, organizerId: string) {
  const facility = await aFacility(tx);
  const { sessionId } = await createSession(tx, organizerId, {
    facilityId: facility.id,
    sport: 'football',
    title: 'Journey weekly football',
    startsAtLocal: await sofiaWallClock(tx, '1 day'),
    rrule: 'FREQ=WEEKLY',
    durationMinutes: 90,
    capacity: 10,
  });
  return { sessionId, occurrenceId: await firstOccurrence(tx, sessionId) };
}

describe.skipIf(!hasDb)('account deletion journey (requires running database)', () => {
  afterAll(closePool);

  it('erases the person and their own data, keeps the audit trail, cancels what they ran', async () => {
    await journey(async (tx) => {
      const leaver = await makeUser(tx, 'leaver');
      const stayer = await makeUser(tx, 'stayer');

      // A contribution (an audit row, a photo and points), a series they
      // organise, a sign-up to somebody else's, and a sign-in code in flight.
      const pin = sofiaPin();
      const photoPath = `photos/journey-${leaver}.webp`;
      const added = await addFacility(tx, {
        userId: leaver,
        input: { name: '', quarter: '', sportTypes: ['archery'], access: 'free', ...pin },
        photoStoragePath: photoPath,
        position: pin,
      });
      const own = await weeklySeries(tx, leaver);
      const theirs = await weeklySeries(tx, stayer);
      await rsvp(tx, leaver, theirs.occurrenceId);
      await tx.execute(sql`
        INSERT INTO verifications (id, identifier, value, expires_at)
        VALUES (${`journey-otp-${leaver}`}, ${`sign-in-otp-${emailOf(leaver)}`}, 'hash',
                now() + interval '10 minutes')
      `);

      const enqueued: { queue: string; data: Record<string, unknown> }[] = [];
      const summary = await deleteAccount(tx, leaver, {
        enqueue: (queue, data) => {
          enqueued.push({ queue, data });
          return Promise.resolve();
        },
      });
      expect(summary).toMatchObject({
        userId: leaver,
        auditRowsPreserved: 1,
        photosAnonymized: 1,
        pointsErased: 1,
        sessionsCancelled: 1,
        rsvpsErased: 1,
        checkinsErased: 0,
      });

      // The profile, and the sign-in code that holds the address, are gone.
      expect(await one(tx, sql`SELECT 1 FROM users WHERE id = ${leaver}`)).toBeUndefined();
      expect(
        await one(
          tx,
          sql`SELECT 1 FROM verifications WHERE identifier LIKE ${`%${emailOf(leaver)}`}`,
        ),
      ).toBeUndefined();
      // Points and sign-ups are the member's own data and leave with them —
      // through the cascade the append-only ledger's trigger lets through.
      expect(
        await one(tx, sql`SELECT count(*)::int AS n FROM points_ledger WHERE user_id = ${leaver}`),
      ).toEqual({ n: 0 });
      expect(
        await one(
          tx,
          sql`SELECT count(*)::int AS n FROM play_session_rsvps WHERE user_id = ${leaver}`,
        ),
      ).toEqual({ n: 0 });

      // The audit trail is untouched and still carries the opaque id…
      expect(
        await one(
          tx,
          sql`SELECT field FROM facility_edits WHERE facility_id = ${added.facilityId}::uuid
                AND actor = ${leaver}`,
        ),
      ).toEqual({ field: 'created' });
      // …while the photo stays, anonymised, and so does the facility.
      expect(
        await one(
          tx,
          sql`SELECT uploaded_by FROM facility_photos WHERE storage_path = ${photoPath}`,
        ),
      ).toEqual({ uploaded_by: null });

      // Their own series is cancelled rather than deleted — other people's
      // history is not theirs to take — and its future date goes with it.
      expect(
        await one(
          tx,
          sql`SELECT status, organizer_id FROM play_sessions WHERE id = ${own.sessionId}::uuid`,
        ),
      ).toEqual({ status: 'cancelled', organizer_id: null });
      expect(
        await one(
          tx,
          sql`SELECT status, cancellation_scope FROM play_session_occurrences
               WHERE id = ${own.occurrenceId}::uuid`,
        ),
      ).toEqual({ status: 'cancelled', cancellation_scope: 'series' });
      // The trigger cancels silently, so the people signed up to it are told
      // through the same notice an organiser's own cancel button sends.
      expect(enqueued).toEqual([
        {
          queue: SESSION_NOTIFY_QUEUE,
          data: { reason: 'series_cancelled', sessionId: own.sessionId },
        },
      ]);
      // Somebody else's session is none of the erasure's business.
      expect(
        await one(tx, sql`SELECT status FROM play_sessions WHERE id = ${theirs.sessionId}::uuid`),
      ).toEqual({ status: 'scheduled' });

      // The tombstone evidences what happened without naming anyone.
      expect(
        await one(
          tx,
          sql`SELECT audit_rows_preserved, photos_anonymized, points_erased,
                     sessions_cancelled, rsvps_erased
                FROM account_deletions WHERE user_id = ${leaver}`,
        ),
      ).toEqual({
        audit_rows_preserved: 1,
        photos_anonymized: 1,
        points_erased: 1,
        sessions_cancelled: 1,
        rsvps_erased: 1,
      });
    });
  });
});

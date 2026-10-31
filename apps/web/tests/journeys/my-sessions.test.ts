import { sql } from '@sportkarta/db';
import { afterAll, describe, expect, it } from 'vitest';

import { facilitySessions, myUpcomingSessions } from '@/lib/sessions/occurrence';

import {
  aFacility,
  closePool,
  firstOccurrence,
  hasDb,
  journey,
  makeUser,
  one,
  type Tx,
} from './db';

/**
 * «Моите записвания» on /igri and «Предстоящи тренировки тук» on a facility
 * page (UX audit N7). The first is somebody's own calendar: it must hold
 * their RSVPs and nobody else's, and nothing withdrawn, cancelled or past. The
 * second is on an indexed page: public series only, still to come.
 */

afterAll(async () => {
  await closePool();
});

async function session(
  tx: Tx,
  organizer: string,
  facilityId: string,
  title: string,
  startsIn: string,
  options: { capacity?: number | null; visibility?: 'public' | 'unlisted' } = {},
): Promise<string> {
  const row = await one<{ id: string }>(
    tx,
    sql`
      INSERT INTO play_sessions (facility_id, sport, organizer_id, title, starts_at_local, duration_minutes, capacity, visibility)
      VALUES (${facilityId}::uuid, 'football', ${organizer}, ${title},
              ((now() + ${startsIn}::interval) AT TIME ZONE 'Europe/Sofia')::timestamp(0), 60,
              ${options.capacity ?? null}, ${options.visibility ?? 'public'})
      RETURNING id
    `,
  );
  return firstOccurrence(tx, String(row?.id));
}

async function rsvp(tx: Tx, occurrenceId: string, userId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO play_session_rsvps (occurrence_id, user_id) VALUES (${occurrenceId}::uuid, ${userId})
  `);
}

describe.skipIf(!hasDb)(
  'my sign-ups and the sessions at a facility (requires running database)',
  () => {
    it('lists my own RSVPs, going or waitlisted, and nothing withdrawn or cancelled', async () => {
      await journey(async (tx) => {
        const me = await makeUser(tx, 'mine_me');
        const other = await makeUser(tx, 'mine_other');
        const { id: facility } = await aFacility(tx);

        const going = await session(tx, other, facility, 'Отивам', '1 day');
        await rsvp(tx, going, me);
        const full = await session(tx, other, facility, 'Пълна', '2 days', { capacity: 1 });
        await rsvp(tx, full, other);
        await rsvp(tx, full, me);
        const theirs = await session(tx, other, facility, 'Чужда', '3 days');
        await rsvp(tx, theirs, other);
        const withdrawn = await session(tx, other, facility, 'Оттеглена', '4 days');
        await rsvp(tx, withdrawn, me);
        await tx.execute(sql`
        UPDATE play_session_rsvps SET state = 'withdrawn', withdrawn_at = now()
         WHERE occurrence_id = ${withdrawn}::uuid AND user_id = ${me}
      `);
        const cancelled = await session(tx, other, facility, 'Отменена', '5 days');
        await rsvp(tx, cancelled, me);
        await tx.execute(sql`
        UPDATE play_session_occurrences
           SET status = 'cancelled', cancelled_at = now(), cancellation_scope = 'occurrence'
         WHERE id = ${cancelled}::uuid
      `);

        const mine = await myUpcomingSessions(me, 10, tx);
        expect(mine.map((s) => [s.title, s.status])).toEqual([
          ['Отивам', 'going'],
          ['Пълна', 'waitlisted'],
        ]);
        // The other account sees its own, never mine.
        expect((await myUpcomingSessions(other, 10, tx)).map((s) => s.title)).toEqual([
          'Пълна',
          'Чужда',
        ]);
      });
    });

    it('shows a facility its public тренировки still to come, and no unlisted one', async () => {
      await journey(async (tx) => {
        const organizer = await makeUser(tx, 'here_org');
        const { id: facility } = await aFacility(tx);
        // aFacility always answers the same first facility; another one by hand.
        const other = await one<{ id: string }>(
          tx,
          sql`SELECT id FROM facilities WHERE status <> 'gone' AND id <> ${facility}::uuid LIMIT 1`,
        );
        const elsewhere = String(other?.id);

        await session(tx, organizer, facility, 'Тук', '1 day', { capacity: 10 });
        await session(tx, organizer, facility, 'Само с връзка', '1 day', {
          visibility: 'unlisted',
        });
        await session(tx, organizer, elsewhere, 'Другаде', '1 day');

        const here = await facilitySessions(facility, 5, tx);
        expect(here.map((s) => [s.title, s.capacity, s.going])).toEqual([['Тук', 10, 0]]);
      });
    });
  },
);

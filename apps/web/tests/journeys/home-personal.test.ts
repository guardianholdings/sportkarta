import { sql } from '@sportkarta/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { homePersonal } from '@/lib/home/personal';

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
 * The front page's personal strip (lib/home/personal.ts) reads ONE account's
 * calendar. Its «Следва» must be a place that account holds — never another
 * account's session, never a waitlist spot (a door with no place behind it),
 * never a booking through a link the account does not hold — and it must find
 * a child's class through the guardian's link, as the calendar feed does.
 *
 * Rolled back like every journey: the fixtures never outlive the test.
 */

const clubsFlag = process.env.CLUBS_ENABLED;

beforeAll(() => {
  // The club half of the strip only reads while the module is on.
  process.env.CLUBS_ENABLED = 'true';
});

afterAll(async () => {
  process.env.CLUBS_ENABLED = clubsFlag;
  await closePool();
});

async function session(
  tx: Tx,
  organizer: string,
  facilityId: string,
  title: string,
  startsIn: string,
  capacity: number | null,
): Promise<string> {
  const row = await one<{ id: string }>(
    tx,
    sql`
      INSERT INTO play_sessions (facility_id, sport, organizer_id, title, starts_at_local, duration_minutes, capacity)
      VALUES (${facilityId}::uuid, 'football', ${organizer}, ${title},
              ((now() + ${startsIn}::interval) AT TIME ZONE 'Europe/Sofia')::timestamp(0), 60, ${capacity})
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

async function club(
  tx: Tx,
  slug: string,
  facilityId: string,
): Promise<{ id: string; location: string }> {
  const row = await one<{ id: string }>(
    tx,
    sql`
      INSERT INTO clubs (slug, name_bg, kind, tier, status, visible, sports, applied_at, approved_at)
      VALUES (${slug}, ${`Клуб ${slug}`}, 'studio', 'community', 'active', true, ARRAY['yoga'], now(), now())
      RETURNING id
    `,
  );
  const id = String(row?.id);
  const location = await one<{ id: string }>(
    tx,
    sql`INSERT INTO club_locations (club_id, name, facility_id)
        VALUES (${id}::uuid, 'Зала', ${facilityId}::uuid) RETURNING id`,
  );
  return { id, location: String(location?.id) };
}

/** A one-off class and its occurrence, `startsIn` from the database's now(). */
async function clubClass(
  tx: Tx,
  where: { id: string; location: string },
  title: string,
  startsIn: string,
  capacity: number,
): Promise<string> {
  const cls = await one<{ id: string }>(
    tx,
    sql`
      INSERT INTO club_classes (club_id, location_id, title, sport, starts_at_local, duration_minutes, capacity, public)
      VALUES (${where.id}::uuid, ${where.location}::uuid, ${title}, 'yoga',
              ((now() + ${startsIn}::interval) AT TIME ZONE 'Europe/Sofia')::timestamp(0), 60, ${capacity}, true)
      RETURNING id
    `,
  );
  const occurrence = await one<{ id: string }>(
    tx,
    sql`
      INSERT INTO club_class_occurrences (club_id, class_id, starts_at, ends_at, starts_at_local)
      SELECT k.club_id, k.id,
             k.starts_at_local AT TIME ZONE 'Europe/Sofia',
             (k.starts_at_local AT TIME ZONE 'Europe/Sofia') + make_interval(mins => k.duration_minutes),
             k.starts_at_local
        FROM club_classes k WHERE k.id = ${String(cls?.id)}::uuid
      RETURNING id
    `,
  );
  return String(occurrence?.id);
}

async function member(
  tx: Tx,
  clubId: string,
  name: string,
  guardian: string | null = null,
): Promise<string> {
  const row = await one<{ id: string }>(
    tx,
    sql`
      INSERT INTO club_members (club_id, display_name, is_minor, guardian_member_id)
      VALUES (${clubId}::uuid, ${name}, ${guardian !== null}, ${guardian}::uuid)
      RETURNING id
    `,
  );
  return String(row?.id);
}

async function link(
  tx: Tx,
  clubId: string,
  memberId: string,
  userId: string,
  status: 'active' | 'pending',
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
    VALUES (${memberId}::uuid, ${clubId}::uuid, ${userId}, ${status}, 'invite')
  `);
}

async function book(tx: Tx, clubId: string, occurrenceId: string, memberId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO club_bookings (club_id, occurrence_id, member_id)
    VALUES (${clubId}::uuid, ${occurrenceId}::uuid, ${memberId}::uuid)
  `);
}

describe.skipIf(!hasDb)("the front page's «Следва» (requires running database)", () => {
  it('shows only a session the account is going to', async () => {
    await journey(async (tx) => {
      const me = await makeUser(tx, 'home_me');
      const other = await makeUser(tx, 'home_other');
      const ahead = await makeUser(tx, 'home_ahead');
      const { id: facility } = await aFacility(tx);

      // Soonest: somebody else's session. Then a full one where I am second
      // in line. Then the one I actually hold.
      const theirs = await session(tx, other, facility, 'Чужда', '3 hours', null);
      await rsvp(tx, theirs, other);
      const full = await session(tx, other, facility, 'Пълна', '6 hours', 1);
      await rsvp(tx, full, ahead);
      await rsvp(tx, full, me);
      const mine = await session(tx, other, facility, 'Моята', '1 day', 10);
      await rsvp(tx, mine, me);

      const strip = await homePersonal(tx, me, 'bg');
      expect(strip.next).toMatchObject({
        kind: 'session',
        title: 'Моята',
        href: `/sesiya/${mine}`,
      });

      // And the other account sees its own, not mine.
      expect((await homePersonal(tx, other, 'bg')).next).toMatchObject({ title: 'Чужда' });
    });
  });

  it("finds a child's class through the guardian's link, and nothing it does not hold", async () => {
    await journey(async (tx) => {
      const me = await makeUser(tx, 'home_parent');
      const { id: facility } = await aFacility(tx);
      const tag = Math.random().toString(36).slice(2, 8);
      const gym = await club(tx, `home-strip-${tag}`, facility);
      const other = await club(tx, `home-strip-pending-${tag}`, facility);

      const myRecord = await member(tx, gym.id, 'Родител');
      await link(tx, gym.id, myRecord, me, 'active');
      const child = await member(tx, gym.id, 'Дете', myRecord);
      const stranger = await member(tx, gym.id, 'Някой');
      // A record in another club whose link is still waiting for the desk.
      const unconfirmed = await member(tx, other.id, 'Аз, непотвърден');
      await link(tx, other.id, unconfirmed, me, 'pending');

      // Soonest: a class booked through the unconfirmed link.
      const viaPending = await clubClass(tx, other, 'Непотвърдена', '1 hour', 10);
      await book(tx, other.id, viaPending, unconfirmed);
      // Then a full class where my own record is waitlisted.
      const full = await clubClass(tx, gym, 'Чакащ', '2 hours', 1);
      await book(tx, gym.id, full, stranger);
      await book(tx, gym.id, full, myRecord);
      // Then my child's class: this is the one.
      const childs = await clubClass(tx, gym, 'Детска йога', '4 hours', 10);
      await book(tx, gym.id, childs, child);

      const strip = await homePersonal(tx, me, 'bg');
      expect(strip.next).toMatchObject({
        kind: 'club',
        title: 'Детска йога',
        href: `/klub/home-strip-${tag}/az`,
      });
    });
  });

  it('offers a check-in only for its own тренировка inside the window, until it is done', async () => {
    await journey(async (tx) => {
      const me = await makeUser(tx, 'home_checkin');
      const other = await makeUser(tx, 'home_checkin_other');
      const { id: facility } = await aFacility(tx);

      // An RSVP needs an occurrence still to come, so each is signed up for
      // first and then moved: mine started ten minutes ago (inside the
      // window), another account's likewise, and one of mine opens in two hours.
      const started = async (title: string, who: string): Promise<string> => {
        const id = await session(tx, other, facility, title, '3 hours', null);
        await rsvp(tx, id, who);
        await tx.execute(sql`
          UPDATE play_session_occurrences
             SET starts_at = now() - interval '10 minutes',
                 ends_at = now() + interval '50 minutes',
                 starts_at_local = ((now() - interval '10 minutes') AT TIME ZONE 'Europe/Sofia')
           WHERE id = ${id}::uuid
        `);
        return id;
      };
      const now = await started('Сега', me);
      await started('Чужда', other);
      const later = await session(tx, other, facility, 'По-късно', '2 hours', null);
      await rsvp(tx, later, me);

      expect((await homePersonal(tx, me, 'bg')).checkin).toMatchObject({ title: 'Сега' });

      await tx.execute(sql`
        INSERT INTO play_session_checkins (occurrence_id, user_id, method)
        VALUES (${now}::uuid, ${me}, 'self')
      `);
      expect((await homePersonal(tx, me, 'bg')).checkin).toBeNull();
    });
  });

  it('is empty, not an error, for an account with nothing booked', async () => {
    await journey(async (tx) => {
      const me = await makeUser(tx, 'home_empty');
      const strip = await homePersonal(tx, me, 'bg');
      expect(strip.next).toBeNull();
      expect(strip.checkin).toBeNull();
      expect(strip.earned).toBe(0);
      expect(strip.total).toBeGreaterThan(0);
      expect(strip.points).toBe(0);
    });
  });
});

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from './client.js';
import { cancelledOccurrenceBookings } from './clubs/mail.js';
import { materializeClubClasses } from './clubs/materialize.js';
import {
  cleanupClubFixtures,
  makeClub,
  makeMember,
  type ClubFixture,
} from './clubs/test-fixtures.js';

/**
 * What the materializer owes an EDITED class (the 2026-11-14 clubs audit):
 *
 *   * a date the new rule no longer has, with somebody booked on it, is
 *     cancelled — and the report NAMES it, because the worker can only tell
 *     the bookers about occurrences it was handed;
 *   * a time changed back puts a date on again only when nobody is booked on
 *     it and nobody was told it is off: a booker who was told believes it,
 *     and the ledger would never tell them about that date again; a date the
 *     office cancelled by hand is never brought back;
 *   * a new duration reaches the occurrences already on the calendar — and
 *     with them the room's claim — one date at a time, so a date whose longer
 *     end would run into another booking of the room keeps its old end and is
 *     reported, never aborting the pass; an occurrence that has started is
 *     history and keeps its end.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('club schedule audit (requires running database)', () => {
  let client: pg.Client;
  let pool: pg.Pool;
  let club: ClubFixture;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  });

  afterAll(async () => {
    await cleanupClubFixtures(client);
    await pool.end();
    await client.end();
  });

  beforeEach(async () => {
    await cleanupClubFixtures(client);
    club = await makeClub(client, 'audit-sched', { paid: true });
  });

  /** A weekly class from tomorrow 18:00 (Sofia), optionally in a room. */
  async function weeklyClass(roomId: string | null = null): Promise<string> {
    const klass = await client.query<{ id: string }>(
      `INSERT INTO club_classes (club_id, location_id, title, sport, starts_at_local, duration_minutes,
                                 rrule, resource_id)
       VALUES ($1, $2, 'Йога', 'yoga', (current_date + 1)::timestamp + interval '18 hours', 60,
               'FREQ=WEEKLY', $3)
       RETURNING id`,
      [club.clubId, club.locationId, roomId],
    );
    return klass.rows[0]?.id ?? '';
  }

  async function room(): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO club_resources (club_id, location_id, kind, name) VALUES ($1, $2, 'room', 'Зала А')
       RETURNING id`,
      [club.clubId, club.locationId],
    );
    return result.rows[0]?.id ?? '';
  }

  const materialize = (classId: string) =>
    materializeClubClasses(pool, { classId, horizonWeeks: 4 });

  async function edit(classId: string, set: string): Promise<void> {
    await client.query(
      `UPDATE club_classes SET ${set}, materialized_through = NULL WHERE id = $1`,
      [classId],
    );
  }

  interface Row {
    id: string;
    status: string;
    scope: string | null;
    clock: string;
    minutes: number;
  }

  /** The class's occurrences still ahead, in date order. */
  async function ahead(classId: string): Promise<Row[]> {
    const rows = await client.query<Row>(
      `SELECT id, status, cancellation_scope AS scope,
              to_char(starts_at AT TIME ZONE 'Europe/Sofia', 'HH24:MI') AS clock,
              (extract(epoch FROM ends_at - starts_at) / 60)::int AS minutes
         FROM club_class_occurrences
        WHERE class_id = $1 AND starts_at > now()
        ORDER BY starts_at`,
      [classId],
    );
    return rows.rows;
  }

  async function book(occurrenceId: string, memberId: string): Promise<void> {
    await client.query(
      `INSERT INTO club_bookings (club_id, occurrence_id, member_id, booked_by)
       VALUES ($1, $2, $3, $4)`,
      [club.clubId, occurrenceId, memberId, club.ownerId],
    );
  }

  it('names the booked dates an edited class no longer has, for the worker to tell the bookers', async () => {
    const classId = await weeklyClass();
    const first = await materialize(classId);
    expect(first.failures).toEqual([]);
    // Nothing was cancelled: nobody to tell.
    expect(first.cancelledOccurrenceIds).toEqual([]);
    const before = await ahead(classId);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const booked = before[0]?.id ?? '';
    const memberId = await makeMember(client, club.clubId, 'Мария');
    await book(booked, memberId);

    await edit(classId, `starts_at_local = starts_at_local + interval '30 minutes'`);
    const moved = await materialize(classId);
    expect(moved.failures).toEqual([]);
    expect(moved.occurrencesCancelled).toBe(1);
    // The dates nobody had booked are simply gone, and are nobody's news.
    expect(moved.occurrencesRemoved).toBe(before.length - 1);
    expect(moved.cancelledOccurrenceIds).toEqual([booked]);
    // Exactly what the `class_cancelled` notice reads: the booker of that date.
    const told = await cancelledOccurrenceBookings(getDb(), moved.cancelledOccurrenceIds);
    expect(told.map((b) => [b.occurrenceId, b.memberId])).toEqual([[booked, memberId]]);

    // The next pass has nothing new to say.
    const again = await materialize(classId);
    expect(again.occurrencesCancelled).toBe(0);
    expect(again.cancelledOccurrenceIds).toEqual([]);
  });

  it('puts a date back on when the time is changed back — unless somebody is booked on it or was told it is off', async () => {
    const classId = await weeklyClass();
    await materialize(classId);
    const before = await ahead(classId);
    expect(before.length).toBeGreaterThanOrEqual(4);
    const [stillBooked, gaveUp, told, byHand] = before.map((row) => row.id) as [
      string,
      string,
      string,
      string,
    ];
    const anna = await makeMember(client, club.clubId, 'Анна');
    const boris = await makeMember(client, club.clubId, 'Борис');
    const vera = await makeMember(client, club.clubId, 'Вера');
    await book(stillBooked, anna);
    await book(gaveUp, boris);
    await book(told, vera);
    // The office cancelled the fourth date itself: that is a decision, not a
    // side effect of an edit, and no edit brings it back.
    await client.query(
      `UPDATE club_class_occurrences
          SET status = 'cancelled', cancelled_at = now(), cancellation_scope = 'occurrence'
        WHERE id = $1`,
      [byHand],
    );

    await edit(classId, `starts_at_local = starts_at_local + interval '30 minutes'`);
    const moved = await materialize(classId);
    expect([...moved.cancelledOccurrenceIds].sort()).toEqual([stillBooked, gaveUp, told].sort());
    // Boris cancels his booking before any notice reached him; Vera was told
    // her class is off (the worker's ledger row), and then cancelled hers.
    await client.query(
      `INSERT INTO club_notifications (club_id, member_id, kind, dedupe_key)
       VALUES ($1, $2::uuid, 'class_cancelled', 'class_cancelled:' || $3::text || ':' || $4::text)`,
      [club.clubId, vera, told, vera],
    );
    await client.query(
      `UPDATE club_bookings SET state = 'cancelled', cancelled_at = now()
        WHERE (occurrence_id, member_id) IN (($1::uuid, $2::uuid), ($3::uuid, $4::uuid))`,
      [gaveUp, boris, told, vera],
    );

    await edit(classId, `starts_at_local = starts_at_local - interval '30 minutes'`);
    const back = await materialize(classId);
    expect(back.failures).toEqual([]);
    expect(back.occurrencesReinstated).toBe(1);
    const after = await ahead(classId);
    const byId = new Map(after.map((row) => [row.id, row]));
    expect(byId.get(gaveUp)).toMatchObject({ status: 'scheduled', scope: null, clock: '18:00' });
    // Anna is still booked on a date she will be told is off: it stays off.
    expect(byId.get(stillBooked)).toMatchObject({ status: 'cancelled', scope: 'series' });
    // Vera was told. The ledger tells a person about a date once, so this
    // date could never announce a second cancellation to her: it stays off.
    expect(byId.get(told)).toMatchObject({ status: 'cancelled', scope: 'series' });
    expect(byId.get(byHand)).toMatchObject({ status: 'cancelled', scope: 'occurrence' });
    // Nothing is left at 18:30.
    const onAt = after.filter((row) => row.status === 'scheduled').map((row) => row.clock);
    expect([...new Set(onAt)]).toEqual(['18:00']);
    // And the reinstated date is not news to anybody: nothing to notify.
    expect(back.cancelledOccurrenceIds).toEqual([]);
  });

  it('carries a new duration to the occurrences already on the calendar, and to their room claim', async () => {
    const roomId = await room();
    const classId = await weeklyClass(roomId);
    const first = await materialize(classId);
    expect(first.occurrencesRetimed).toBe(0);
    const before = await ahead(classId);
    expect(before.every((row) => row.minutes === 60)).toBe(true);

    await edit(classId, 'duration_minutes = 90');
    const longer = await materialize(classId);
    expect(longer.failures).toEqual([]);
    expect(longer.conflicts).toEqual([]);
    expect(longer.occurrencesRetimed).toBe(before.length);
    const after = await ahead(classId);
    expect(after.map((row) => [row.id, row.status, row.minutes])).toEqual(
      before.map((row) => [row.id, 'scheduled', 90]),
    );
    const claims = await client.query<{ minutes: number }>(
      `SELECT (extract(epoch FROM upper(c.during) - lower(c.during)) / 60)::int AS minutes
         FROM club_calendar_claims c
         JOIN club_class_occurrences o ON o.id = c.source_id
        WHERE c.source = 'occurrence' AND o.class_id = $1`,
      [classId],
    );
    expect(claims.rows.map((row) => row.minutes)).toEqual(before.map(() => 90));

    // Idempotent: the next pass finds every end where it belongs.
    expect((await materialize(classId)).occurrencesRetimed).toBe(0);
  });

  it('keeps the old end on a date whose room is taken right after it, and reports that date', async () => {
    const roomId = await room();
    const classId = await weeklyClass(roomId);
    await materialize(classId);
    const before = await ahead(classId);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const blocked = before[1]?.id ?? '';
    // Somebody rents the room for the hour straight after the second date.
    const memberId = await makeMember(client, club.clubId, 'Вяра');
    const service = await client.query<{ id: string }>(
      `INSERT INTO club_services (club_id, location_id, kind, name_bg, duration_min, duration_max,
                                  price_cents)
       VALUES ($1, $2, 'rental', 'Зала под наем', 60, 120, 2000) RETURNING id`,
      [club.clubId, club.locationId],
    );
    await client.query(
      `INSERT INTO club_reservations (club_id, service_id, member_id, resource_id, starts_at, ends_at,
                                      price_cents, cancel_deadline_hours)
       SELECT $1, $2, $3, $4, o.ends_at, o.ends_at + interval '1 hour', 2000, 24
         FROM club_class_occurrences o WHERE o.id = $5`,
      [club.clubId, service.rows[0]?.id, memberId, roomId, blocked],
    );

    await edit(classId, 'duration_minutes = 90');
    const longer = await materialize(classId);
    // One date could not grow; the pass went on to the rest.
    expect(longer.failures).toEqual([]);
    expect(longer.conflicts).toHaveLength(1);
    expect(longer.occurrencesRetimed).toBe(before.length - 1);
    const after = await ahead(classId);
    expect(after.map((row) => [row.id, row.status, row.minutes])).toEqual(
      before.map((row) => [row.id, 'scheduled', row.id === blocked ? 60 : 90]),
    );
    // The skipped date still holds its room for its old hour.
    const held = await client.query(
      `SELECT 1 FROM club_calendar_claims WHERE source = 'occurrence' AND source_id = $1`,
      [blocked],
    );
    expect(held.rows).toHaveLength(1);
  });

  it('never re-times an occurrence that has already started', async () => {
    // A weekly class whose first date began two hours ago (inside the
    // materializer's one-day lookback, so the row exists).
    const klass = await client.query<{ id: string }>(
      `INSERT INTO club_classes (club_id, location_id, title, sport, starts_at_local, duration_minutes,
                                 rrule)
       VALUES ($1, $2, 'Йога', 'yoga',
               date_trunc('hour', now() AT TIME ZONE 'Europe/Sofia') - interval '2 hours', 60,
               'FREQ=WEEKLY')
       RETURNING id`,
      [club.clubId, club.locationId],
    );
    const classId = klass.rows[0]?.id ?? '';
    await materialize(classId);
    await edit(classId, 'duration_minutes = 90');
    await materialize(classId);
    const rows = await client.query<{ started: boolean; minutes: number }>(
      `SELECT starts_at <= now() AS started,
              (extract(epoch FROM ends_at - starts_at) / 60)::int AS minutes
         FROM club_class_occurrences WHERE class_id = $1 ORDER BY starts_at`,
      [classId],
    );
    expect(rows.rows[0]).toEqual({ started: true, minutes: 60 });
    expect(rows.rows.slice(1).every((row) => !row.started && row.minutes === 90)).toBe(true);
    expect(rows.rows.length).toBeGreaterThanOrEqual(2);
  });
});

import { instantToWall, isoWeekday, SOFIA_TZ } from '@sportkarta/lib/recurrence';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  claimDigestSend,
  formatWeekStart,
  weeklyDigest,
  weekStartFor,
  weekWindow,
} from './digest.js';

/**
 * The weekly digest (docs/ROADMAP.md §6, Stage 4.4).
 *
 * Two things are proven here. The week is a SOFIA WALL-CLOCK week — Monday
 * midnight to Monday midnight — which means the week containing a DST
 * transition is 167 or 169 hours long and still starts at midnight. And the
 * send ledger really is once-per-subscriber-per-week, under concurrency.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const ORGANIZER_ID = 'e2e_digest_org';
const MEMBER_ID = 'e2e_digest_member';
const TITLE = 'e2e-digest Тренировка';
const HOUR_MS = 60 * 60 * 1000;

describe('week window (pure)', () => {
  it('always starts on a Sofia Monday at midnight', () => {
    for (let day = 0; day < 400; day += 1) {
      const now = new Date(Date.UTC(2026, 0, 1) + day * 24 * HOUR_MS + 13 * HOUR_MS);
      const start = weekStartFor(now, SOFIA_TZ);
      expect(isoWeekday(start)).toBe(1);
      expect(start.hour).toBe(0);
      expect(start.minute).toBe(0);
      // …and the instant it maps to reads as Monday 00:00 locally.
      const { from } = weekWindow(start, SOFIA_TZ);
      const local = instantToWall(from.getTime(), SOFIA_TZ);
      expect(isoWeekday(local)).toBe(1);
      expect(local.hour).toBe(0);
    }
  });

  it('is 167 or 169 hours long exactly on the DST-transition weeks', () => {
    const lengths = new Map<number, number>();
    for (let week = 0; week < 60; week += 1) {
      const now = new Date(Date.UTC(2026, 0, 5) + week * 7 * 24 * HOUR_MS);
      const start = weekStartFor(now, SOFIA_TZ);
      const { from, to } = weekWindow(start, SOFIA_TZ);
      const hours = (to.getTime() - from.getTime()) / HOUR_MS;
      lengths.set(hours, (lengths.get(hours) ?? 0) + 1);
    }
    // Most weeks are 168 h; exactly one is short and one is long each year.
    expect(lengths.get(168)).toBeGreaterThan(50);
    expect(lengths.get(167)).toBe(1);
    expect(lengths.get(169)).toBe(1);
  });

  it('formats the week start as the YYYY-MM-DD the ledger stores', () => {
    const start = weekStartFor(new Date('2026-09-03T12:00:00Z'), SOFIA_TZ);
    expect(formatWeekStart(start)).toBe('2026-08-31');
  });
});

describe.skipIf(!hasDb)('weeklyDigest (requires running database)', () => {
  let client: pg.Client;
  let db: ReturnType<typeof drizzle>;
  let pool: pg.Pool;
  let facilityId: string;
  let municipalityId: number;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool);
    const facility = await client.query<{ id: string; municipality_id: number }>(
      `SELECT id, municipality_id FROM facilities
        WHERE municipality_id IS NOT NULL AND status <> 'gone'
        ORDER BY created_at, id LIMIT 1`,
    );
    facilityId = facility.rows[0]?.id ?? '';
    municipalityId = facility.rows[0]?.municipality_id ?? 0;
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
    await pool.end();
  });

  beforeEach(async () => {
    await cleanup();
    await client.query(
      `INSERT INTO users (id, display_name, email) VALUES
         ($1, 'Организатор', 'digest-org@example.org'),
         ($2, 'Член', 'digest-member@example.org')`,
      [ORGANIZER_ID, MEMBER_ID],
    );
  });

  async function cleanup(): Promise<void> {
    await client.query(`DELETE FROM play_sessions WHERE organizer_id = $1 OR title = $2`, [
      ORGANIZER_ID,
      TITLE,
    ]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[ORGANIZER_ID, MEMBER_ID]]);
  }

  /** A session with one occurrence at a given Sofia wall clock. */
  async function seedOccurrence(
    startsAtLocal: string,
    options: { visibility?: string; sessionStatus?: string; occurrenceStatus?: string } = {},
  ): Promise<string> {
    const session = await client.query<{ id: string }>(
      `INSERT INTO play_sessions
         (facility_id, sport, organizer_id, title, starts_at_local, duration_minutes, capacity, visibility, status)
       VALUES ($1::uuid, 'football', $2, $3, $4::timestamp, 90, 10, $5::play_session_visibility, $6::play_session_status)
       RETURNING id`,
      [
        facilityId,
        ORGANIZER_ID,
        TITLE,
        startsAtLocal,
        options.visibility ?? 'public',
        options.sessionStatus ?? 'scheduled',
      ],
    );
    const cancelled = (options.occurrenceStatus ?? 'scheduled') === 'cancelled';
    const occurrence = await client.query<{ id: string }>(
      `INSERT INTO play_session_occurrences
         (session_id, starts_at, ends_at, starts_at_local, status, cancelled_at, cancellation_scope)
       VALUES ($1::uuid,
               ($2::timestamp AT TIME ZONE 'Europe/Sofia'),
               ($2::timestamp AT TIME ZONE 'Europe/Sofia') + interval '90 minutes',
               $2::timestamp,
               $3::play_session_status,
               CASE WHEN $4 THEN now() END,
               CASE WHEN $4 THEN 'occurrence'::play_session_cancel_scope END)
       RETURNING id`,
      [session.rows[0]?.id, startsAtLocal, options.occurrenceStatus ?? 'scheduled', cancelled],
    );
    return occurrence.rows[0]?.id ?? '';
  }

  const WEEK = { year: 2026, month: 8, day: 31, hour: 0, minute: 0 };

  it('returns the week, in order, with the going count', async () => {
    await seedOccurrence('2026-09-02T18:00:00');
    await seedOccurrence('2026-09-01T19:00:00');
    const week = await weeklyDigest(db, { municipalityId, weekStart: WEEK });

    const mine = week.occurrences.filter((o) => o.title === TITLE);
    expect(mine.map((o) => o.startsAtLocal)).toEqual([
      '2026-09-01T19:00:00',
      '2026-09-02T18:00:00',
    ]);
    expect(week.weekStart).toBe('2026-08-31');
    expect(mine[0]?.going).toBe(0);
  });

  it('counts only members who are going, not the whole waitlist', async () => {
    // capacity 10 and one RSVP: that person is going.
    const occurrenceId = await seedOccurrence('2026-09-02T18:00:00');
    await client.query(
      `INSERT INTO play_session_rsvps (occurrence_id, user_id) VALUES ($1::uuid, $2)`,
      [occurrenceId, MEMBER_ID],
    );
    const week = await weeklyDigest(db, { municipalityId, weekStart: WEEK });
    expect(week.occurrences.find((o) => o.occurrenceId === occurrenceId)?.going).toBe(1);
  });

  it('excludes cancelled, unlisted and out-of-window sessions', async () => {
    await seedOccurrence('2026-09-02T18:00:00', { occurrenceStatus: 'cancelled' });
    await seedOccurrence('2026-09-03T18:00:00', { visibility: 'unlisted' });
    await seedOccurrence('2026-09-04T18:00:00', { sessionStatus: 'cancelled' });
    // The Monday after the window closes.
    await seedOccurrence('2026-09-07T18:00:00');

    const week = await weeklyDigest(db, { municipalityId, weekStart: WEEK });
    expect(week.occurrences.filter((o) => o.title === TITLE)).toHaveLength(0);
  });

  it('includes the last minute of Sunday and excludes the first of Monday', async () => {
    await seedOccurrence('2026-09-06T23:59:00');
    const inside = await weeklyDigest(db, { municipalityId, weekStart: WEEK });
    expect(inside.occurrences.filter((o) => o.title === TITLE)).toHaveLength(1);

    await client.query(`DELETE FROM play_sessions WHERE title = $1`, [TITLE]);
    await seedOccurrence('2026-09-07T00:00:00');
    const outside = await weeklyDigest(db, { municipalityId, weekStart: WEEK });
    expect(outside.occurrences.filter((o) => o.title === TITLE)).toHaveLength(0);
  });

  it('spans a DST transition without losing the Sunday evening', async () => {
    // The week containing 2026-10-25 (clocks go back) is 169 hours long.
    const week = { year: 2026, month: 10, day: 19, hour: 0, minute: 0 };
    await seedOccurrence('2026-10-25T20:00:00');
    const result = await weeklyDigest(db, { municipalityId, weekStart: week });
    expect(result.occurrences.filter((o) => o.title === TITLE)).toHaveLength(1);
    expect((result.to.getTime() - result.from.getTime()) / HOUR_MS).toBe(169);
  });

  describe('the send ledger', () => {
    it('claims a week exactly once, even under concurrent workers', async () => {
      const clients = await Promise.all(
        Array.from({ length: 5 }, async () => {
          const extra = new pg.Pool({ connectionString: process.env.DATABASE_URL });
          return drizzle(extra);
        }),
      );
      const claims = await Promise.all(
        clients.map((c) => claimDigestSend(c, MEMBER_ID, municipalityId, '2026-08-31')),
      );
      // Exactly one worker owns the send; the rest see it is already claimed.
      expect(claims.filter(Boolean)).toHaveLength(1);
    });

    it('refuses a week_start that is not a Monday', async () => {
      // The guard against a UTC worker keying a Sofia Monday to the Sunday —
      // it makes that whole class of slip a loud failure BEFORE any mail goes
      // out, because the ledger row is claimed first.
      // (drizzle wraps driver errors, so the constraint name is on the cause.)
      const rejection = await claimDigestSend(db, MEMBER_ID, municipalityId, '2026-09-01').then(
        () => null,
        (error: unknown) => error,
      );
      expect(rejection).not.toBeNull();
      const cause = (rejection as { cause?: { constraint?: string } }).cause;
      expect(cause?.constraint).toBe('digest_sends_week_start_is_monday');
    });

    it('lets the next week through', async () => {
      expect(await claimDigestSend(db, MEMBER_ID, municipalityId, '2026-08-31')).toBe(true);
      expect(await claimDigestSend(db, MEMBER_ID, municipalityId, '2026-08-31')).toBe(false);
      expect(await claimDigestSend(db, MEMBER_ID, municipalityId, '2026-09-07')).toBe(true);
    });

    it('leaves with the account, and cannot block erasure', async () => {
      await claimDigestSend(db, MEMBER_ID, municipalityId, '2026-08-31');
      await client.query(
        `INSERT INTO digest_subscriptions (user_id, municipality_id, unsubscribe_token)
         VALUES ($1, $2, 'aaaaaaaaaaaaaaaaaaaaaaaa')`,
        [MEMBER_ID, municipalityId],
      );
      await expect(
        client.query(`DELETE FROM users WHERE id = $1`, [MEMBER_ID]),
      ).resolves.toBeTruthy();
      const left = await client.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM digest_sends WHERE user_id = $1)
              + (SELECT count(*) FROM digest_subscriptions WHERE user_id = $1) AS n`,
        [MEMBER_ID],
      );
      expect(Number(left.rows[0]?.n)).toBe(0);
    });
  });
});

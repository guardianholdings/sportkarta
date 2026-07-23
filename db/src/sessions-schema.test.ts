import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The play-layer constraints, proven against real Postgres (migration 0008).
 *
 * The RRULE grammar CHECK carries a specific burden: drizzle-kit truncates a
 * CHECK expression at the first ';' inside a string literal, so every
 * regeneration mangles `play_sessions_rrule_supported` and the correct SQL is
 * written by hand. The assertions here are the guard the migration header
 * promises — a regeneration that reintroduces the truncation fails these rather
 * than shipping a session table that accepts rules the engine cannot expand.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

const ORGANIZER_ID = 'e2e_sessions_schema_org';

describe.skipIf(!hasDb)('play session constraints (requires running database)', () => {
  let client: pg.Client;
  let facilityId: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const facility = await client.query<{ id: string }>(
      `SELECT id FROM facilities ORDER BY created_at, id LIMIT 1`,
    );
    facilityId = facility.rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  beforeEach(async () => {
    await cleanup();
    await client.query(
      `INSERT INTO users (id, display_name, email) VALUES ($1, 'Тест', 'sessions-schema@example.org')`,
      [ORGANIZER_ID],
    );
  });

  async function cleanup(): Promise<void> {
    // Scoped to this suite's own rows only. Vitest runs test files in parallel
    // against the one dev database, so a broader predicate here would delete
    // another suite's fixtures mid-test.
    await client.query(`DELETE FROM play_sessions WHERE organizer_id = $1`, [ORGANIZER_ID]);
    await client.query(`DELETE FROM users WHERE id = $1`, [ORGANIZER_ID]);
  }

  async function insertSession(overrides: Record<string, unknown> = {}): Promise<string> {
    const row = {
      sport: 'football',
      title: 'Футбол в кв. Лозенец',
      starts_at_local: '2026-09-01T18:00:00',
      rrule: null as string | null,
      duration_minutes: 90,
      capacity: null as number | null,
      ...overrides,
    };
    const result = await client.query<{ id: string }>(
      `INSERT INTO play_sessions
         (facility_id, sport, organizer_id, title, starts_at_local, rrule, duration_minutes, capacity)
       VALUES ($1::uuid, $2, $3, $4, $5::timestamp, $6, $7, $8)
       RETURNING id`,
      [
        facilityId,
        row.sport,
        ORGANIZER_ID,
        row.title,
        row.starts_at_local,
        row.rrule,
        row.duration_minutes,
        row.capacity,
      ],
    );
    return result.rows[0]?.id ?? '';
  }

  describe('the RRULE grammar CHECK', () => {
    const accepted = [
      null,
      'FREQ=WEEKLY',
      'FREQ=DAILY',
      'FREQ=WEEKLY;BYDAY=TU,TH',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA',
      'FREQ=DAILY;COUNT=10',
      'FREQ=WEEKLY;UNTIL=20261231T235959Z',
      'FREQ=WEEKLY;WKST=MO;BYDAY=MO',
    ];

    it.each(accepted)('accepts %s', async (rrule) => {
      await expect(insertSession({ rrule })).resolves.toBeTruthy();
    });

    const rejected: [string, string][] = [
      // The whole point of the subset: no monthly, no ordinals, no set positions.
      ['FREQ=MONTHLY', 'rrule_supported'],
      // Two constraints both catch this one; Postgres reports whichever it
      // evaluates first, so assert only that it is refused.
      ['FREQ=MONTHLY;BYDAY=1SA', 'violates check constraint'],
      ['FREQ=YEARLY', 'rrule_supported'],
      ['FREQ=WEEKLY;BYSETPOS=-1', 'rrule_supported'],
      ['FREQ=WEEKLY;BYMONTHDAY=15', 'rrule_supported'],
      ['FREQ=WEEKLY;BYDAY=1SA', 'rrule_supported'],
      ['FREQ=WEEKLY;WKST=SU', 'rrule_supported'],
      ['FREQ=WEEKLY;INTERVAL=0', 'rrule_supported'],
      ['freq=weekly', 'rrule_supported'],
      ['FREQ=WEEKLY;', 'rrule_supported'],
      ['FREQ=WEEKLY;BYDAY=', 'rrule_supported'],
      // A calendar-invalid UNTIL the engine would refuse to parse.
      ['FREQ=WEEKLY;UNTIL=20261332T256199Z', 'rrule_supported'],
      // Cross-part rules.
      ['FREQ=DAILY;BYDAY=MO', 'rrule_byday_weekly_only'],
      ['FREQ=WEEKLY;COUNT=5;UNTIL=20261231T235959Z', 'rrule_count_xor_until'],
      ['FREQ=WEEKLY;INTERVAL=2;INTERVAL=3', 'rrule_no_repeats'],
      ['FREQ=WEEKLY;BYDAY=MO;BYDAY=TU', 'rrule_no_repeats'],
    ];

    it.each(rejected)('rejects %s', async (rrule, constraint) => {
      await expect(insertSession({ rrule })).rejects.toThrow(constraint);
    });
  });

  it('refuses a live series with no organiser, and a nonsensical duration or capacity', async () => {
    await expect(
      client.query(
        `INSERT INTO play_sessions (facility_id, sport, title, starts_at_local, duration_minutes)
         VALUES ($1::uuid, 'football', 'Без организатор', '2026-09-01T18:00:00'::timestamp, 90)`,
        [facilityId],
      ),
    ).rejects.toThrow('play_sessions_live_has_organizer');

    await expect(insertSession({ duration_minutes: 5 })).rejects.toThrow('duration_sane');
    await expect(insertSession({ duration_minutes: 1440 })).rejects.toThrow('duration_sane');
    await expect(insertSession({ capacity: 0 })).rejects.toThrow('capacity_sane');
    await expect(insertSession({ title: '   ' })).rejects.toThrow('title_not_blank');
    await expect(insertSession({ sport: 'Football' })).rejects.toThrow('sport_format');
  });

  it('refuses a timezone other than Europe/Sofia', async () => {
    await expect(
      client.query(
        `INSERT INTO play_sessions
           (facility_id, sport, organizer_id, title, starts_at_local, timezone, duration_minutes)
         VALUES ($1::uuid, 'football', $2, 'Друга зона', '2026-09-01T18:00:00'::timestamp, 'Europe/Berlin', 90)`,
        [facilityId, ORGANIZER_ID],
      ),
    ).rejects.toThrow('timezone_supported');
  });

  describe('the occurrence local-clock trigger', () => {
    it('rejects a wall clock that disagrees with the instant', async () => {
      const sessionId = await insertSession();
      await expect(
        client.query(
          `INSERT INTO play_session_occurrences (session_id, starts_at, ends_at, starts_at_local)
           VALUES ($1::uuid, '2026-09-01T15:00:00Z', '2026-09-01T16:30:00Z', '2026-09-01T17:00:00'::timestamp)`,
          [sessionId],
        ),
        // 15:00Z is 18:00 in Sofia, not 17:00 — this is the guard against a
        // writer whose tz database disagrees with this server's.
      ).rejects.toThrow(/disagrees with/);
    });

    it('accepts the pair the engine actually produces', async () => {
      const sessionId = await insertSession();
      await expect(
        client.query(
          `INSERT INTO play_session_occurrences (session_id, starts_at, ends_at, starts_at_local)
           VALUES ($1::uuid, '2026-09-01T15:00:00Z', '2026-09-01T16:30:00Z', '2026-09-01T18:00:00'::timestamp)`,
          [sessionId],
        ),
      ).resolves.toBeTruthy();
    });

    it('does not re-verify on an update that leaves both columns alone', async () => {
      // This is what keeps GDPR erasure unblockable: the cancellation cascade
      // runs inside DELETE FROM users, and must not re-litigate old rows
      // against a tz database that may have been updated since.
      const sessionId = await insertSession();
      await client.query(
        `INSERT INTO play_session_occurrences (session_id, starts_at, ends_at, starts_at_local)
         VALUES ($1::uuid, '2026-09-01T15:00:00Z', '2026-09-01T16:30:00Z', '2026-09-01T18:00:00'::timestamp)`,
        [sessionId],
      );
      // Corrupt the pair behind the trigger's back, the way a tzdata change
      // effectively would, then perform an unrelated update. try/finally so a
      // failure here cannot leave the trigger disabled for every later test.
      await client.query(
        `ALTER TABLE play_session_occurrences DISABLE TRIGGER play_session_occurrences_verify_local_update`,
      );
      try {
        await client.query(
          `UPDATE play_session_occurrences SET starts_at_local = '2026-09-01T17:00:00'::timestamp
            WHERE session_id = $1::uuid`,
          [sessionId],
        );
      } finally {
        await client.query(
          `ALTER TABLE play_session_occurrences ENABLE TRIGGER play_session_occurrences_verify_local_update`,
        );
      }
      await expect(
        client.query(
          `UPDATE play_session_occurrences
              SET status = 'cancelled', cancelled_at = now(), cancellation_scope = 'series'
            WHERE session_id = $1::uuid`,
          [sessionId],
        ),
      ).resolves.toBeTruthy();
    });
  });

  it('keeps the cancellation fields together', async () => {
    const sessionId = await insertSession();
    await expect(
      client.query(
        `INSERT INTO play_session_occurrences
           (session_id, starts_at, ends_at, starts_at_local, status)
         VALUES ($1::uuid, '2026-09-01T15:00:00Z', '2026-09-01T16:30:00Z',
                 '2026-09-01T18:00:00'::timestamp, 'cancelled')`,
        [sessionId],
      ),
    ).rejects.toThrow('cancel_fields');
  });
});

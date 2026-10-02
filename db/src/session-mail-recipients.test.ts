import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { renderSql } from './render-sql.js';
import {
  recipientsFor,
  seriesCancellationRecipients,
  waitlistPlaceSql,
} from './sessions/notifications.js';

/**
 * What a session email is told about its recipient (docs/ROADMAP.md §6,
 * Stage 4.2) — the three facts the pre-launch audit found wrong or missing:
 *
 *  - the WAITLIST place. `play_session_rsvp_positions.position` numbers going
 *    and waiting members together, so the first person waiting for a
 *    ten-place game is position 11 — and was told "you are number 11 on the
 *    waitlist", on the page and in the mail. They are number 1.
 *  - whether the member has a calendar feed — as a flag. The token is a
 *    credential and used to be printed into every confirmation.
 *  - who is told when an organiser erases their account. The trigger cancels
 *    their series silently; the recipients query must still find the members.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 * Every instant is relative to now(): a fixture on a fixed date expires with
 * the calendar, and 0008's trigger then refuses the RSVPs.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const ORGANIZER_ID = 'e2e_smr_org';
const MEMBER_IDS = ['e2e_smr_a', 'e2e_smr_b', 'e2e_smr_c'] as const;
const TITLE = 'e2e-smr Волейбол';
const FEED_TOKEN = 'e2eSmrFeedToken_0123456789abcdef';

describe('waitlistPlaceSql (pure)', () => {
  it('subtracts the view’s own capacity, and only for waiting members', () => {
    const { sql: text } = renderSql(sql`SELECT ${waitlistPlaceSql('p')}`);
    expect(text).toContain(`"p".rsvp_status = 'waitlisted'`);
    expect(text).toContain('"p".position - "p".capacity');
  });
});

describe.skipIf(!hasDb)('session mail recipients (requires running database)', () => {
  let client: pg.Client;
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle>;
  let facilityId: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool);
    const facility = await client.query<{ id: string }>(
      `SELECT id FROM facilities ORDER BY created_at, id LIMIT 1`,
    );
    facilityId = facility.rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
    await pool.end();
  });

  beforeEach(async () => {
    await cleanup();
    await client.query(
      `INSERT INTO users (id, display_name, email) VALUES ($1, 'Организатор', 'smr-org@example.org')`,
      [ORGANIZER_ID],
    );
    for (const [index, id] of MEMBER_IDS.entries()) {
      // The last member never set a name — OTP sign-up leaves it empty.
      await client.query(`INSERT INTO users (id, display_name, email) VALUES ($1, $2, $3)`, [
        id,
        index === MEMBER_IDS.length - 1 ? '' : 'Играч',
        `smr-${String(index)}@example.org`,
      ]);
    }
  });

  async function cleanup(): Promise<void> {
    // By title as well: after the organiser's erasure the series has no
    // organizer_id left to find it by.
    await client.query(`DELETE FROM play_sessions WHERE organizer_id = $1 OR title = $2`, [
      ORGANIZER_ID,
      TITLE,
    ]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [
      [ORGANIZER_ID, ...MEMBER_IDS],
    ]);
  }

  /** A series with one occurrence five days from now. Returns both ids. */
  async function makeOccurrence(
    capacity: number | null,
  ): Promise<{ sessionId: string; occurrenceId: string }> {
    const session = await client.query<{ id: string }>(
      `INSERT INTO play_sessions
         (facility_id, sport, organizer_id, title, starts_at_local, duration_minutes, capacity)
       VALUES ($1::uuid, 'volleyball', $2, $3,
               (date_trunc('minute', now()) + interval '5 days') AT TIME ZONE 'Europe/Sofia',
               90, $4)
       RETURNING id`,
      [facilityId, ORGANIZER_ID, TITLE, capacity],
    );
    const sessionId = session.rows[0]?.id ?? '';
    // starts_at_local is derived from starts_at in the series zone, which is
    // exactly what 0008's verify trigger checks.
    const occurrence = await client.query<{ id: string }>(
      `INSERT INTO play_session_occurrences (session_id, starts_at, ends_at, starts_at_local)
       SELECT $1::uuid, t, t + interval '90 minutes', t AT TIME ZONE 'Europe/Sofia'
         FROM (SELECT date_trunc('minute', now()) + interval '5 days' AS t) x
       RETURNING id`,
      [sessionId],
    );
    return { sessionId, occurrenceId: occurrence.rows[0]?.id ?? '' };
  }

  /** Join in array order — one statement each, so the arrival tickets are ordered. */
  async function joinAll(occurrenceId: string): Promise<void> {
    for (const id of MEMBER_IDS) {
      await client.query(
        `INSERT INTO play_session_rsvps (occurrence_id, user_id) VALUES ($1::uuid, $2)`,
        [occurrenceId, id],
      );
    }
  }

  it('tells the first person waiting that they are number 1, not capacity + 1', async () => {
    const { occurrenceId } = await makeOccurrence(1);
    await joinAll(occurrenceId);

    const recipients = await recipientsFor(db, occurrenceId, [...MEMBER_IDS]);
    expect(recipients.map((r) => [r.userId, r.rsvpStatus, r.position, r.waitlistPlace])).toEqual([
      ['e2e_smr_a', 'going', 1, null],
      // The audit's replica: capacity 1, the second member was mailed
      // "Вие сте номер 2 в списъка на чакащите". They are first in line.
      ['e2e_smr_b', 'waitlisted', 2, 1],
      ['e2e_smr_c', 'waitlisted', 3, 2],
    ]);
  });

  it('has no waitlist at all when the session is unlimited', async () => {
    const { occurrenceId } = await makeOccurrence(null);
    await joinAll(occurrenceId);
    const recipients = await recipientsFor(db, occurrenceId, [...MEMBER_IDS]);
    expect(recipients.every((r) => r.rsvpStatus === 'going' && r.waitlistPlace === null)).toBe(
      true,
    );
  });

  it('gives the session page the same number the mail gets', async () => {
    // apps/web/lib/sessions/occurrence.ts reads the viewer's place through the
    // same fragment; this is that read, verbatim in shape.
    const { occurrenceId } = await makeOccurrence(1);
    await joinAll(occurrenceId);
    const result = await db.execute(sql`
      SELECT p.user_id, ${waitlistPlaceSql('p')} AS place
        FROM play_session_rsvp_positions p
       WHERE p.occurrence_id = ${occurrenceId}::uuid
       ORDER BY p.position
    `);
    expect(result.rows.map((row) => [row.user_id, row.place])).toEqual([
      ['e2e_smr_a', null],
      ['e2e_smr_b', 1],
      ['e2e_smr_c', 2],
    ]);
  });

  it('knows a member has a calendar feed without ever reading the token', async () => {
    const { occurrenceId } = await makeOccurrence(5);
    await joinAll(occurrenceId);
    await client.query(`INSERT INTO calendar_tokens (user_id, token) VALUES ($1, $2)`, [
      MEMBER_IDS[0],
      FEED_TOKEN,
    ]);

    const recipients = await recipientsFor(db, occurrenceId, [...MEMBER_IDS]);
    expect(recipients.map((r) => r.hasCalendarFeed)).toEqual([true, false, false]);
    // The credential never enters the mail path at all.
    expect(JSON.stringify(recipients)).not.toContain(FEED_TOKEN);
    // …and a missing name arrives as '' for the renderer's name-less greeting.
    expect(recipients[2]?.displayName).toBe('');
  });

  it('still finds the members after the organiser erases their account', async () => {
    const { sessionId, occurrenceId } = await makeOccurrence(5);
    await joinAll(occurrenceId);

    // The erasure's own statement. organizer_id goes NULL, the orphan trigger
    // cancels the series, the cascade cancels this future occurrence — and
    // apps/web/lib/account-deletion.ts then enqueues series_cancelled for it.
    await client.query(`DELETE FROM users WHERE id = $1`, [ORGANIZER_ID]);

    const status = await client.query<{ status: string }>(
      `SELECT status FROM play_session_occurrences WHERE id = $1::uuid`,
      [occurrenceId],
    );
    expect(status.rows[0]?.status).toBe('cancelled');

    const recipients = await seriesCancellationRecipients(db, sessionId);
    expect(recipients.map((r) => r.userId)).toEqual([...MEMBER_IDS]);
    expect(recipients.every((r) => r.occurrenceId === occurrenceId)).toBe(true);
  });
});

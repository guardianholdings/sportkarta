import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The session-mail idempotency ledger (docs/ROADMAP.md §6, Stage 4.2).
 *
 * The claim under test is that play_session_notifications tells two things
 * apart that a flat UNIQUE (occurrence, member, kind) cannot:
 *
 *   - a fact about the OCCURRENCE, told once however the member's RSVP moves
 *     afterwards (both reminders, the cancellation);
 *   - a fact about ONE SIGN-UP, told once per arrival ticket (confirmed,
 *     waitlisted, promoted).
 *
 * The second one matters far more than it looks. Migration 0008 lets a member
 * withdraw and re-join, which draws a fresh ticket. Under a flat key, somebody
 * who withdrew, re-joined the waitlist and was then let back in would never be
 * told — the ledger would insist they already had been. They would believe they
 * were still queued and not turn up, and nothing anywhere would report an
 * error. These tests are what stops that being reintroduced.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const ORGANIZER_ID = 'e2e_notify_org';
const MEMBER_ID = 'e2e_notify_member';

type Kind =
  | 'rsvp_confirmed'
  | 'rsvp_waitlisted'
  | 'promoted'
  | 'reminder_24h'
  | 'reminder_2h'
  | 'occurrence_cancelled';

const RSVP_SCOPED: Kind[] = ['rsvp_confirmed', 'rsvp_waitlisted', 'promoted'];
const OCCURRENCE_SCOPED: Kind[] = ['reminder_24h', 'reminder_2h', 'occurrence_cancelled'];

describe.skipIf(!hasDb)('session notification ledger (requires running database)', () => {
  let client: pg.Client;
  let facilityId: string;
  let occurrenceId: string;

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
      `INSERT INTO users (id, display_name, email) VALUES ($1, 'Организатор', 'notify-org@example.org')`,
      [ORGANIZER_ID],
    );
    await client.query(
      `INSERT INTO users (id, display_name, email) VALUES ($1, 'Играч', 'notify@example.org')`,
      [MEMBER_ID],
    );
    const session = await client.query<{ id: string }>(
      `INSERT INTO play_sessions
         (facility_id, sport, organizer_id, title, starts_at_local, duration_minutes, capacity)
       VALUES ($1::uuid, 'volleyball', $2, 'Волейбол', '2027-06-01T19:00:00'::timestamp, 90, 1)
       RETURNING id`,
      [facilityId, ORGANIZER_ID],
    );
    const occurrence = await client.query<{ id: string }>(
      `INSERT INTO play_session_occurrences (session_id, starts_at, ends_at, starts_at_local)
       VALUES ($1::uuid, '2027-06-01T16:00:00Z', '2027-06-01T17:30:00Z',
               '2027-06-01T19:00:00'::timestamp)
       RETURNING id`,
      [session.rows[0]?.id],
    );
    occurrenceId = occurrence.rows[0]?.id ?? '';
  });

  async function cleanup(): Promise<void> {
    await client.query(`DELETE FROM play_sessions WHERE organizer_id = $1`, [ORGANIZER_ID]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[ORGANIZER_ID, MEMBER_ID]]);
  }

  /** The production claim statement, verbatim in shape (db/src/sessions/notifications.ts). */
  async function claim(kind: Kind, rsvpSeq: number | null): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO play_session_notifications (occurrence_id, user_id, kind, rsvp_seq)
       VALUES ($1::uuid, $2, $3::play_session_notification_kind, $4)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [occurrenceId, MEMBER_ID, kind, rsvpSeq],
    );
    return result.rowCount === 1;
  }

  /** Join or re-join, exactly as lib/sessions/rsvp.ts does. Returns the ticket. */
  async function join(): Promise<number> {
    const result = await client.query<{ seq: string }>(
      `INSERT INTO play_session_rsvps (occurrence_id, user_id)
       VALUES ($1::uuid, $2)
       ON CONFLICT (occurrence_id, user_id) DO UPDATE
         SET state = 'active', withdrawn_at = NULL, updated_at = now(),
             seq = CASE WHEN play_session_rsvps.state = 'withdrawn'
                        THEN nextval('play_session_rsvp_seq')
                        ELSE play_session_rsvps.seq END
       RETURNING seq`,
      [occurrenceId, MEMBER_ID],
    );
    return Number(result.rows[0]?.seq);
  }

  async function withdraw(): Promise<void> {
    await client.query(
      `UPDATE play_session_rsvps SET state = 'withdrawn', withdrawn_at = now(), updated_at = now()
        WHERE occurrence_id = $1::uuid AND user_id = $2 AND state = 'active'`,
      [occurrenceId, MEMBER_ID],
    );
  }

  describe('facts about the occurrence', () => {
    it('are claimable exactly once', async () => {
      for (const kind of OCCURRENCE_SCOPED) {
        expect(await claim(kind, null)).toBe(true);
        expect(await claim(kind, null)).toBe(false);
      }
    });

    it('stay claimed across a withdrawal and a re-join', async () => {
      await join();
      expect(await claim('reminder_24h', null)).toBe(true);
      await withdraw();
      await join();
      // The member's ticket changed; "24 hours to go" did not become news again.
      expect(await claim('reminder_24h', null)).toBe(false);
    });

    it('do not collide with each other', async () => {
      expect(await claim('reminder_24h', null)).toBe(true);
      expect(await claim('reminder_2h', null)).toBe(true);
      expect(await claim('occurrence_cancelled', null)).toBe(true);
    });
  });

  describe('facts about one sign-up', () => {
    it('are claimable once per arrival ticket', async () => {
      const seq = await join();
      for (const kind of RSVP_SCOPED) {
        expect(await claim(kind, seq)).toBe(true);
        expect(await claim(kind, seq)).toBe(false);
      }
    });

    it('become claimable again after a withdrawal and a re-join', async () => {
      const first = await join();
      expect(await claim('rsvp_confirmed', first)).toBe(true);

      await withdraw();
      const second = await join();
      // Re-joining draws a FRESH ticket (migration 0008) …
      expect(second).toBeGreaterThan(first);
      // … so the confirmation for the new sign-up is not suppressed.
      expect(await claim('rsvp_confirmed', second)).toBe(true);
    });

    it('let somebody be promoted a second time — the bug this key exists for', async () => {
      // Waitlisted, promoted, told. Then they withdraw, re-join, and a spot
      // opens again. Under a flat key the second promotion is swallowed and
      // they never learn they are in.
      const first = await join();
      expect(await claim('promoted', first)).toBe(true);

      await withdraw();
      const second = await join();
      expect(await claim('promoted', second)).toBe(true);
    });
  });

  describe('the kind decides which key applies, in the database', () => {
    it('refuses a sign-up notification with no arrival ticket', async () => {
      for (const kind of RSVP_SCOPED) {
        await expect(claim(kind, null)).rejects.toThrow(
          /play_session_notifications_seq_matches_kind/,
        );
      }
    });

    it('refuses an occurrence notification that carries one', async () => {
      const seq = await join();
      for (const kind of OCCURRENCE_SCOPED) {
        await expect(claim(kind, seq)).rejects.toThrow(
          /play_session_notifications_seq_matches_kind/,
        );
      }
    });
  });

  describe('the ledger is the member’s own data', () => {
    it('leaves with the account, and cannot block the erasure', async () => {
      const seq = await join();
      await claim('rsvp_confirmed', seq);
      await claim('reminder_24h', null);

      // The whole point of CASCADE here: erasure must never be blockable.
      await expect(
        client.query(`DELETE FROM users WHERE id = $1`, [MEMBER_ID]),
      ).resolves.toBeDefined();

      const left = await client.query(
        `SELECT count(*)::int AS n FROM play_session_notifications WHERE user_id = $1`,
        [MEMBER_ID],
      );
      expect(left.rows[0]?.n).toBe(0);
    });
  });

  describe('calendar tokens', () => {
    it('refuse a token that is the account id', async () => {
      // better-auth ids satisfy the shape rule, so only this CHECK stops a
      // regression putting a live session subject into third-party logs.
      await expect(
        client.query(`INSERT INTO calendar_tokens (user_id, token) VALUES ($1, $1)`, [
          'aaaaaaaaaaaaaaaaaaaaaaaa',
        ]),
      ).rejects.toThrow(/calendar_tokens_token_is_not_the_account_id|violates foreign key/);
    });

    it('refuse a short token', async () => {
      await expect(
        client.query(`INSERT INTO calendar_tokens (user_id, token) VALUES ($1, 'short')`, [
          MEMBER_ID,
        ]),
      ).rejects.toThrow(/calendar_tokens_token_shape/);
    });

    it('accept a generated one, and rotation keeps exactly one row', async () => {
      await client.query(
        `INSERT INTO calendar_tokens (user_id, token) VALUES ($1, 'aaaaaaaaaaaaaaaaaaaaaaaa')`,
        [MEMBER_ID],
      );
      await client.query(
        `INSERT INTO calendar_tokens (user_id, token) VALUES ($1, 'bbbbbbbbbbbbbbbbbbbbbbbb')
         ON CONFLICT (user_id) DO UPDATE SET token = EXCLUDED.token, rotated_at = now()`,
        [MEMBER_ID],
      );
      const rows = await client.query<{ token: string }>(
        `SELECT token FROM calendar_tokens WHERE user_id = $1`,
        [MEMBER_ID],
      );
      // Revocation is one row moving, so every copy of the old URL dies at once.
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0]?.token).toBe('bbbbbbbbbbbbbbbbbbbbbbbb');
    });
  });
});

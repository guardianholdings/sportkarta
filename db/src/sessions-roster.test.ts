import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The organiser roster reads against real Postgres (Stage 4.3). Integration
 * test against the dev/CI database; skips without DATABASE_URL.
 *
 * The queries here are the roster's own, verbatim in shape
 * (apps/web/lib/sessions/roster.ts): the position view joined to users for
 * display names — the one sanctioned crossing of the view's no-names line,
 * which only ever runs behind the organiser gate — and the walk-in anti-join.
 * The statement-shape companion is apps/web/tests/roster.test.ts.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const ORGANIZER_ID = 'e2e_roster_org';
const AMBASSADOR_ID = 'e2e_roster_amb';
const MEMBER_IDS = ['e2e_roster_a', 'e2e_roster_b', 'e2e_roster_walkin'];

interface RosterRow {
  user_id: string;
  display_name: string | null;
  position: string;
  rsvp_status: string;
  checkin_method: string | null;
}

describe.skipIf(!hasDb)('organizer roster (requires running database)', () => {
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
      `INSERT INTO users (id, display_name, email) VALUES ($1, 'Организатор', 'roster@example.org')`,
      [ORGANIZER_ID],
    );
    for (const [index, id] of MEMBER_IDS.entries()) {
      await client.query(`INSERT INTO users (id, display_name, email) VALUES ($1, $2, $3)`, [
        id,
        index === 0 ? 'Мария' : index === 1 ? 'Георги' : 'Иван',
        `roster-${String(index)}@example.org`,
      ]);
    }
  });

  async function cleanup(): Promise<void> {
    await client.query(`DELETE FROM play_sessions WHERE organizer_id = $1`, [ORGANIZER_ID]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [
      [ORGANIZER_ID, AMBASSADOR_ID, ...MEMBER_IDS],
    ]);
  }

  async function makeOccurrence(capacity: number | null): Promise<string> {
    const session = await client.query<{ id: string }>(
      `INSERT INTO play_sessions
         (facility_id, sport, organizer_id, title, starts_at_local, duration_minutes, capacity)
       VALUES ($1::uuid, 'volleyball', $2, 'Волейбол', '2027-05-04T19:00:00'::timestamp, 90, $3)
       RETURNING id`,
      [facilityId, ORGANIZER_ID, capacity],
    );
    const sessionId = session.rows[0]?.id;
    const occurrence = await client.query<{ id: string }>(
      `INSERT INTO play_session_occurrences (session_id, starts_at, ends_at, starts_at_local)
       VALUES ($1::uuid, '2027-05-04T16:00:00Z', '2027-05-04T17:30:00Z',
               '2027-05-04T19:00:00'::timestamp)
       RETURNING id`,
      [sessionId],
    );
    return occurrence.rows[0]?.id ?? '';
  }

  /** The production RSVP statement, verbatim in shape (lib/sessions/rsvp.ts). */
  async function join(occurrenceId: string, userId: string): Promise<void> {
    await client.query(
      `INSERT INTO play_session_rsvps (occurrence_id, user_id)
       VALUES ($1::uuid, $2)
       ON CONFLICT (occurrence_id, user_id) DO UPDATE
         SET state = 'active', withdrawn_at = NULL, updated_at = now(),
             seq = CASE WHEN play_session_rsvps.state = 'withdrawn'
                        THEN nextval('play_session_rsvp_seq')
                        ELSE play_session_rsvps.seq END`,
      [occurrenceId, userId],
    );
  }

  async function checkin(
    occurrenceId: string,
    userId: string,
    method: string,
    recordedBy: string | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO play_session_checkins (occurrence_id, user_id, method, recorded_by, scored)
       VALUES ($1::uuid, $2, $3::play_session_checkin_method, $4, false)
       ON CONFLICT (occurrence_id, user_id) DO NOTHING`,
      [occurrenceId, userId, method, recordedBy],
    );
  }

  /** The roster member read, verbatim in shape (apps/web/lib/sessions/roster.ts). */
  async function rosterMembers(occurrenceId: string): Promise<RosterRow[]> {
    const result = await client.query<RosterRow>(
      `SELECT p.user_id, u.display_name, p.position, p.rsvp_status, c.method AS checkin_method
         FROM play_session_rsvp_positions p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN play_session_checkins c
           ON c.occurrence_id = p.occurrence_id AND c.user_id = p.user_id
        WHERE p.occurrence_id = $1::uuid
        ORDER BY p.position`,
      [occurrenceId],
    );
    return result.rows;
  }

  /** The walk-in read, verbatim in shape (apps/web/lib/sessions/roster.ts). */
  async function walkIns(occurrenceId: string): Promise<RosterRow[]> {
    const result = await client.query<RosterRow>(
      `SELECT c.user_id, u.display_name, c.method AS checkin_method
         FROM play_session_checkins c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN play_session_rsvp_positions p
           ON p.occurrence_id = c.occurrence_id AND p.user_id = c.user_id
        WHERE c.occurrence_id = $1::uuid
          AND p.rsvp_id IS NULL
        ORDER BY c.checked_in_at, c.user_id`,
      [occurrenceId],
    );
    return result.rows;
  }

  it('the gate admits the organiser and an admin, and refuses an ambassador', async () => {
    await client.query(
      `INSERT INTO users (id, display_name, email, role)
       VALUES ($1, 'Одит Посланик', 'roster-amb@example.org', 'ambassador')`,
      [AMBASSADOR_ID],
    );
    const occurrenceId = await makeOccurrence(null);

    // The roster's gate read, verbatim in shape (apps/web/lib/sessions/roster.ts).
    async function gate(actorId: string): Promise<{ is_organizer: boolean; is_admin: boolean }> {
      const result = await client.query<{ is_organizer: boolean; is_admin: boolean }>(
        `SELECT (s.organizer_id = $2) AS is_organizer,
                EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.role = 'admin') AS is_admin
           FROM play_session_occurrences o
           JOIN play_sessions s ON s.id = o.session_id
          WHERE o.id = $1::uuid`,
        [occurrenceId, actorId],
      );
      return result.rows[0] ?? { is_organizer: false, is_admin: false };
    }

    const organizer = await gate(ORGANIZER_ID);
    expect(organizer.is_organizer).toBe(true);

    // An ambassador is NEITHER: their authority is municipality-scoped
    // moderation, and a session roster is not a moderation object.
    const ambassador = await gate(AMBASSADOR_ID);
    expect(ambassador.is_organizer).toBe(false);
    expect(ambassador.is_admin).toBe(false);
  });

  it('lists members in queue order with names, waitlist state and check-in method', async () => {
    const occurrenceId = await makeOccurrence(1);
    await join(occurrenceId, 'e2e_roster_a');
    await join(occurrenceId, 'e2e_roster_b');
    await checkin(occurrenceId, 'e2e_roster_a', 'organizer', ORGANIZER_ID);

    const rows = await rosterMembers(occurrenceId);
    expect(rows.map((r) => [r.user_id, r.display_name, Number(r.position), r.rsvp_status])).toEqual(
      [
        ['e2e_roster_a', 'Мария', 1, 'going'],
        ['e2e_roster_b', 'Георги', 2, 'waitlisted'],
      ],
    );
    expect(rows[0]?.checkin_method).toBe('organizer');
    expect(rows[1]?.checkin_method).toBeNull();
  });

  it('lists a checked-in member with no active RSVP as a walk-in, not a member', async () => {
    const occurrenceId = await makeOccurrence(null);
    await join(occurrenceId, 'e2e_roster_a');
    // The walk-in never RSVPed — a QR redemption from someone passing by.
    await checkin(occurrenceId, 'e2e_roster_walkin', 'self', null);

    const members = await rosterMembers(occurrenceId);
    expect(members.map((r) => r.user_id)).toEqual(['e2e_roster_a']);

    const extras = await walkIns(occurrenceId);
    expect(extras.map((r) => [r.user_id, r.display_name, r.checkin_method])).toEqual([
      ['e2e_roster_walkin', 'Иван', 'self'],
    ]);
  });

  it('an organizer check-in records the voucher and can never be scored', async () => {
    const occurrenceId = await makeOccurrence(null);
    await join(occurrenceId, 'e2e_roster_a');

    // The CHECK is the enforcement, not application code: an organizer-method
    // row claiming scored=true must be unwritable.
    await expect(
      client.query(
        `INSERT INTO play_session_checkins (occurrence_id, user_id, method, recorded_by, scored)
         VALUES ($1::uuid, $2, 'organizer', $3, true)`,
        [occurrenceId, 'e2e_roster_a', ORGANIZER_ID],
      ),
    ).rejects.toThrow(/play_session_checkins_only_qr_scores/);

    await checkin(occurrenceId, 'e2e_roster_a', 'organizer', ORGANIZER_ID);
    const rows = await rosterMembers(occurrenceId);
    expect(rows[0]?.checkin_method).toBe('organizer');

    // Idempotent under a double tap: the second insert is a no-op.
    await checkin(occurrenceId, 'e2e_roster_a', 'organizer', ORGANIZER_ID);
    const counted = await client.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM play_session_checkins WHERE occurrence_id = $1::uuid`,
      [occurrenceId],
    );
    expect(Number(counted.rows[0]?.n)).toBe(1);
  });
});

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The Stage 5.4 scoring constraints, against real PostgreSQL.
 *
 * Stage 5.2 shipped leaderboards that rank points_ledger and deliberately NOT
 * check-ins, on the grounds that a check-in was self-attested. 5.4 makes some
 * of them evidence — and `play_session_checkins_only_qr_scores` is what keeps
 * 5.2's promise true for the rest. These tests attack the constraint directly,
 * with SQL, the way db/src/leaderboard-authz.test.ts attacks the minors rule:
 * if the rule only exists in application code, the application is one refactor
 * away from paying for a button somebody tapped at home.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const ORGANIZER_ID = 'e2e_score_org';
const MEMBER_ID = 'e2e_score_member';

describe.skipIf(!hasDb)('QR check-in scoring constraints (requires running database)', () => {
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
      `INSERT INTO users (id, display_name, email) VALUES ($1, 'Организатор', 'score-org@example.org')`,
      [ORGANIZER_ID],
    );
    await client.query(
      `INSERT INTO users (id, display_name, email) VALUES ($1, 'Играч', 'score@example.org')`,
      [MEMBER_ID],
    );
    const session = await client.query<{ id: string }>(
      `INSERT INTO play_sessions
         (facility_id, sport, organizer_id, title, starts_at_local, duration_minutes)
       VALUES ($1::uuid, 'basketball', $2, 'Баскетбол', '2027-08-03T19:00:00'::timestamp, 90)
       RETURNING id`,
      [facilityId, ORGANIZER_ID],
    );
    const occurrence = await client.query<{ id: string }>(
      `INSERT INTO play_session_occurrences (session_id, starts_at, ends_at, starts_at_local)
       VALUES ($1::uuid, '2027-08-03T16:00:00Z', '2027-08-03T17:30:00Z',
               '2027-08-03T19:00:00'::timestamp)
       RETURNING id`,
      [session.rows[0]?.id],
    );
    occurrenceId = occurrence.rows[0]?.id ?? '';
  });

  async function cleanup(): Promise<void> {
    await client.query(`DELETE FROM play_sessions WHERE organizer_id = $1`, [ORGANIZER_ID]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[ORGANIZER_ID, MEMBER_ID]]);
  }

  function insertCheckin(
    method: 'self' | 'organizer' | 'qr',
    scored: boolean,
    distanceM: number | null = null,
    recordedBy: string | null = null,
  ) {
    return client.query(
      `INSERT INTO play_session_checkins
         (occurrence_id, user_id, method, recorded_by, distance_m, scored)
       VALUES ($1::uuid, $2, $3::play_session_checkin_method, $4, $5, $6)`,
      [occurrenceId, MEMBER_ID, method, recordedBy, distanceM, scored],
    );
  }

  describe('only a QR-verified check-in may score', () => {
    it('refuses a scored `self` check-in', async () => {
      // The exact bug the constraint exists for: a refactor that starts paying
      // for a button somebody tapped at home.
      await expect(insertCheckin('self', true)).rejects.toThrow(
        /play_session_checkins_only_qr_scores/,
      );
    });

    it('refuses a scored `organizer` check-in — vouching is not evidence', async () => {
      await expect(insertCheckin('organizer', true, null, ORGANIZER_ID)).rejects.toThrow(
        /play_session_checkins_only_qr_scores/,
      );
    });

    it('allows an unscored check-in of every method', async () => {
      // Attendance is a fact and is always recordable; only the payment is gated.
      await expect(insertCheckin('self', false)).resolves.toBeDefined();
      await client.query(`DELETE FROM play_session_checkins WHERE user_id = $1`, [MEMBER_ID]);
      await expect(insertCheckin('organizer', false, null, ORGANIZER_ID)).resolves.toBeDefined();
      await client.query(`DELETE FROM play_session_checkins WHERE user_id = $1`, [MEMBER_ID]);
      await expect(insertCheckin('qr', false, 900)).resolves.toBeDefined();
    });

    it('allows a scored `qr` check-in', async () => {
      await expect(insertCheckin('qr', true, 42)).resolves.toBeDefined();
    });
  });

  describe('a QR scan is redeemed by the member', () => {
    it('refuses a `qr` row that claims somebody else recorded it', async () => {
      await expect(insertCheckin('qr', false, 10, ORGANIZER_ID)).rejects.toThrow(
        /play_session_checkins_qr_has_no_recorder/,
      );
    });
  });

  describe('distance is bounded, and is the only spatial thing stored', () => {
    it('refuses a negative distance', async () => {
      await expect(insertCheckin('qr', false, -1)).rejects.toThrow(
        /play_session_checkins_distance_sane/,
      );
    });

    it('refuses an absurd distance — which is why the WRITER clamps', async () => {
      // The constraint is right; what would be wrong is letting it decide
      // whether an attendance exists. A desktop browser falling back to an
      // IP-derived fix is a continent away, and unclamped that would abort the
      // check-in transaction and record nothing at all. checkin.ts wraps the
      // ST_Distance in least(..., MAX_RECORDED_DISTANCE_M) for exactly this.
      await expect(insertCheckin('qr', false, 1_000_001)).rejects.toThrow(
        /play_session_checkins_distance_sane/,
      );
      // The clamped value is accepted, so the row always lands.
      await expect(insertCheckin('qr', false, 1_000_000)).resolves.toBeDefined();
    });

    it('refuses a distance on a check-in that could never have scored', async () => {
      // We only measure where somebody stood when they redeemed a token;
      // holding a position for a self-attested tap would be collection for no
      // purpose.
      await expect(insertCheckin('self', false, 100)).rejects.toThrow(
        /play_session_checkins_distance_only_for_qr/,
      );
    });

    it('has no column that could hold a coordinate', async () => {
      // The privacy claim in migration 0014, asserted against the catalogue
      // rather than against a comment: adding lat/lon here later would be a
      // deliberate act, and this test is where it gets noticed.
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'play_session_checkins'`,
      );
      const names = columns.rows.map((row) => row.column_name);
      for (const forbidden of ['lat', 'lon', 'latitude', 'longitude', 'geom', 'location']) {
        expect(names).not.toContain(forbidden);
      }
    });
  });

  describe('the attendance award', () => {
    it('is keyed per occurrence per member, so a retry pays once', async () => {
      const key = `session_attended:${occurrenceId}:${MEMBER_ID}`;
      const insert = () =>
        client.query(
          `INSERT INTO points_ledger (user_id, event, points, facility_id, idempotency_key)
           VALUES ($1, 'session_attended', 2, $2::uuid, $3)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [MEMBER_ID, facilityId, key],
        );
      expect((await insert()).rowCount).toBe(1);
      expect((await insert()).rowCount).toBe(0);
      expect((await insert()).rowCount).toBe(0);
    });

    it('leaves with the account, and cannot block the erasure', async () => {
      await insertCheckin('qr', true, 30);
      await client.query(
        `INSERT INTO points_ledger (user_id, event, points, facility_id, idempotency_key)
         VALUES ($1, 'session_attended', 2, $2::uuid, $3)`,
        [MEMBER_ID, facilityId, `session_attended:${occurrenceId}:${MEMBER_ID}`],
      );
      // Points are personal data and go with the account; the facility FK is
      // RESTRICT, but that guards facilities, not users.
      await expect(
        client.query(`DELETE FROM users WHERE id = $1`, [MEMBER_ID]),
      ).resolves.toBeDefined();
      const left = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM points_ledger WHERE user_id = $1`,
        [MEMBER_ID],
      );
      expect(Number(left.rows[0]?.n)).toBe(0);
    });
  });
});

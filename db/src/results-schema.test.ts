import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The results constraints (migration 0009, docs/ROADMAP.md §6 Stage 4.6).
 *
 * The load-bearing one is the LAST test: `participant_user_id` is ON DELETE SET
 * NULL, so "a result identifies somebody" had to become a BEFORE INSERT trigger
 * rather than a CHECK. As a CHECK it would be re-evaluated by the SET NULL
 * update and abort `DELETE FROM users` forever — the one failure mode CLAUDE.md
 * says must never happen.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const ORGANIZER_ID = 'e2e_results_org';
const PLAYER_ID = 'e2e_results_player';
const TITLE = 'e2e-results Тренировка';

describe.skipIf(!hasDb)('play_session_results (requires running database)', () => {
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
      `INSERT INTO users (id, display_name, email) VALUES
         ($1, 'Организатор', 'results-org@example.org'),
         ($2, 'Играч', 'results-player@example.org')`,
      [ORGANIZER_ID, PLAYER_ID],
    );
    const session = await client.query<{ id: string }>(
      `INSERT INTO play_sessions
         (facility_id, sport, organizer_id, title, starts_at_local, duration_minutes)
       VALUES ($1::uuid, 'football', $2, $3, '2020-05-04T19:00:00'::timestamp, 90)
       RETURNING id`,
      [facilityId, ORGANIZER_ID, TITLE],
    );
    const occurrence = await client.query<{ id: string }>(
      `INSERT INTO play_session_occurrences (session_id, starts_at, ends_at, starts_at_local)
       VALUES ($1::uuid, '2020-05-04T16:00:00Z', '2020-05-04T17:30:00Z',
               '2020-05-04T19:00:00'::timestamp)
       RETURNING id`,
      [session.rows[0]?.id],
    );
    occurrenceId = occurrence.rows[0]?.id ?? '';
  });

  async function cleanup(): Promise<void> {
    await client.query(`DELETE FROM play_sessions WHERE organizer_id = $1 OR title = $2`, [
      ORGANIZER_ID,
      TITLE,
    ]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[ORGANIZER_ID, PLAYER_ID]]);
  }

  function insert(values: Record<string, unknown>): Promise<pg.QueryResult> {
    const row = {
      participant_user_id: null,
      participant_label: null,
      team: null,
      position: null,
      score: null,
      note: null,
      ...values,
    };
    return client.query(
      `INSERT INTO play_session_results
         (occurrence_id, participant_user_id, participant_label, team, position, score, note)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)`,
      [
        occurrenceId,
        row.participant_user_id,
        row.participant_label,
        row.team,
        row.position,
        row.score,
        row.note,
      ],
    );
  }

  it('accepts a member row, a guest row and a team row', async () => {
    await expect(insert({ participant_user_id: PLAYER_ID, position: 1 })).resolves.toBeTruthy();
    await expect(insert({ participant_label: 'гост', position: 2 })).resolves.toBeTruthy();
    await expect(
      insert({ participant_label: 'Отбор А', team: 'Отбор А', score: '3:1' }),
    ).resolves.toBeTruthy();
  });

  it('accepts a typed time as a score — no timing hardware, by design', async () => {
    // score is text precisely so it fits football, tennis and a 5 km run.
    for (const score of ['3:1', '12:34', '21-19, 19-21, 15-12']) {
      await client.query(`DELETE FROM play_session_results WHERE occurrence_id = $1::uuid`, [
        occurrenceId,
      ]);
      await expect(insert({ participant_label: 'бегач', score })).resolves.toBeTruthy();
    }
  });

  it('refuses a row that identifies nobody', async () => {
    await expect(insert({ position: 1 })).rejects.toThrow(
      /must name a member or carry a participant label/,
    );
    await expect(insert({ participant_label: '   ', position: 1 })).rejects.toThrow(
      /must name a member or carry a participant label/,
    );
  });

  it('refuses a row that says nothing happened', async () => {
    await expect(insert({ participant_label: 'гост' })).rejects.toThrow('has_content');
    // A team alone is not content — it says who, not what.
    await expect(insert({ participant_label: 'гост', team: 'А' })).rejects.toThrow('has_content');
    // A note alone IS content: "DNF" is a result.
    await expect(insert({ participant_label: 'гост', note: 'DNF' })).resolves.toBeTruthy();
  });

  it('refuses a non-positive position and blank strings', async () => {
    await expect(insert({ participant_label: 'гост', position: 0 })).rejects.toThrow(
      'position_positive',
    );
    await expect(insert({ participant_label: 'гост', position: 1, score: '  ' })).rejects.toThrow(
      'text_sane',
    );
    await expect(
      insert({ participant_label: 'гост', position: 1, note: 'x'.repeat(301) }),
    ).rejects.toThrow('text_sane');
  });

  it('allows a tie but not two rows for the same member', async () => {
    await insert({ participant_label: 'а', position: 1 });
    // Ties are real results — the occurrence index is deliberately not unique.
    await expect(insert({ participant_label: 'б', position: 1 })).resolves.toBeTruthy();

    await insert({ participant_user_id: PLAYER_ID, position: 3 });
    await expect(insert({ participant_user_id: PLAYER_ID, position: 4 })).rejects.toThrow(
      'occurrence_member_unique',
    );
  });

  it('anonymises rather than deletes when a participant erases their account', async () => {
    // THE test this file exists for. As a CHECK, "identifies somebody" would
    // make this DELETE fail forever.
    await insert({ participant_user_id: PLAYER_ID, position: 1, score: '12:34' });
    await insert({ participant_label: 'гост', position: 2 });

    await expect(
      client.query(`DELETE FROM users WHERE id = $1`, [PLAYER_ID]),
    ).resolves.toBeTruthy();

    const rows = await client.query<{
      participant_user_id: string | null;
      participant_label: string | null;
      score: string | null;
    }>(
      `SELECT participant_user_id, participant_label, score
         FROM play_session_results WHERE occurrence_id = $1::uuid ORDER BY position`,
      [occurrenceId],
    );
    // The result survives — it is a fact about a game the other player was in
    // too — with the person's reference cleared.
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.participant_user_id).toBeNull();
    expect(rows.rows[0]?.participant_label).toBeNull();
    expect(rows.rows[0]?.score).toBe('12:34');
    // …and both-null is unambiguous, because a guest always has a label.
    expect(rows.rows[1]?.participant_label).toBe('гост');
  });

  it('goes away with the occurrence, and with the session above it', async () => {
    await insert({ participant_label: 'гост', position: 1 });
    await client.query(`DELETE FROM play_sessions WHERE title = $1`, [TITLE]);
    const left = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM play_session_results WHERE occurrence_id = $1::uuid`,
      [occurrenceId],
    );
    expect(Number(left.rows[0]?.n)).toBe(0);
  });
});

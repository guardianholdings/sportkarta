import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { facilityLegend, LEGEND_MIN_DAYS } from './legend.js';

/**
 * «Господар на игрището» against real Postgres.
 *
 * The three properties that matter are all rules somebody could plausibly
 * "simplify" away, so each is asserted rather than trusted:
 *
 *  1. ONLY `qr` COUNTS. Migration 0014 made that the evidence tier by CHECK —
 *     `self` is a tap and `organizer` is a vouch. A legend counted over all
 *     methods re-opens exactly the hole that CHECK closed.
 *  2. DISTINCT SOFIA DAYS, not check-ins. Two occurrences on one day is one day
 *     of showing up.
 *  3. A MINIMUM. Below it the title does not render, because a "legend" with one
 *     visit is not one — and on a quiet facility a count of 1 beside a title is
 *     close to naming the only person who goes there.
 *
 * Integration test; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

const A = 'e2e_legend_a';
const B = 'e2e_legend_b';

interface Runner {
  execute(query: { queryChunks?: unknown }): Promise<{ rows: Record<string, unknown>[] }>;
}

describe.skipIf(!hasDb)('facilityLegend (requires running database)', () => {
  let client: pg.Client;
  let db: Runner;
  let facilityId = '';
  let occurrences: string[] = [];

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const { drizzle } = await import('drizzle-orm/node-postgres');
    db = drizzle(client) as unknown as Runner;

    // A facility that actually has occurrences to check into.
    const row = await client.query<{ facility_id: string }>(
      `SELECT s.facility_id FROM play_sessions s
         JOIN play_session_occurrences o ON o.session_id = s.id
        GROUP BY s.facility_id HAVING count(*) >= 3 LIMIT 1`,
    );
    facilityId = row.rows[0]?.facility_id ?? '';
    const occ = await client.query<{ id: string }>(
      `SELECT o.id FROM play_session_occurrences o
         JOIN play_sessions s ON s.id = o.session_id
        WHERE s.facility_id = $1::uuid ORDER BY o.starts_at LIMIT 4`,
      [facilityId],
    );
    occurrences = occ.rows.map((r) => r.id);
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  beforeEach(async () => {
    await cleanup();
    for (const [id, email] of [
      [A, 'legend-a@example.org'],
      [B, 'legend-b@example.org'],
    ]) {
      await client.query(`INSERT INTO users (id, display_name, email) VALUES ($1, 'Тест', $2)`, [
        id,
        email,
      ]);
    }
  });

  async function cleanup(): Promise<void> {
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[A, B]]);
  }

  /** A check-in `daysAgo` days back, at a chosen occurrence and method. */
  async function checkIn(
    userId: string,
    occurrenceIndex: number,
    daysAgo: number,
    method: 'qr' | 'self' | 'organizer' = 'qr',
  ): Promise<void> {
    const occurrenceId = occurrences[occurrenceIndex];
    if (!occurrenceId) throw new Error('fixture: not enough occurrences in the dev database');
    await client.query(
      `INSERT INTO play_session_checkins (occurrence_id, user_id, method, scored, checked_in_at)
       VALUES ($1::uuid, $2, $3, false, now() - ($4 || ' days')::interval)
       ON CONFLICT (occurrence_id, user_id) DO NOTHING`,
      [occurrenceId, userId, method, String(daysAgo)],
    );
  }

  it('has a usable fixture (guards a vacuous pass)', () => {
    expect(facilityId).not.toBe('');
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
  });

  it('returns nobody below the minimum', async () => {
    await checkIn(A, 0, 1);
    await checkIn(A, 1, 2);
    // Two distinct days, one short of LEGEND_MIN_DAYS.
    expect(LEGEND_MIN_DAYS).toBe(3);
    expect(await facilityLegend(db as never, facilityId)).toBeNull();
  });

  it('crowns the member with the most distinct days', async () => {
    await checkIn(A, 0, 1);
    await checkIn(A, 1, 2);
    await checkIn(A, 2, 3);
    const legend = await facilityLegend(db as never, facilityId);
    expect(legend?.holderUserId).toBe(A);
    expect(legend?.days).toBe(3);
  });

  it('IGNORES self and organizer check-ins — only qr is evidence (0014)', async () => {
    // B taps "I am here" three times; A never does. Nobody qualifies.
    await checkIn(B, 0, 1, 'self');
    await checkIn(B, 1, 2, 'organizer');
    await checkIn(B, 2, 3, 'self');
    expect(await facilityLegend(db as never, facilityId)).toBeNull();
  });

  it('does not count a member out of the rolling window', async () => {
    await checkIn(A, 0, 100);
    await checkIn(A, 1, 120);
    await checkIn(A, 2, 200);
    expect(await facilityLegend(db as never, facilityId)).toBeNull();
  });

  it('never returns a display name — the facility page must not be able to print one', async () => {
    await checkIn(A, 0, 1);
    await checkIn(A, 1, 2);
    await checkIn(A, 2, 3);
    const legend = await facilityLegend(db as never, facilityId);
    expect(legend).not.toBeNull();
    // The shape IS the guarantee: /obekt/[slug] is indexed and cannot be
    // noindex, so a name there would publish a named person tied to one place
    // with a 90-day frequency count (operator decision 2026-07-26).
    expect(Object.keys(legend ?? {}).sort()).toEqual(['days', 'holderUserId']);
  });
});

import { randomUUID } from 'node:crypto';

import { getDb, getPool, sql, type SQL } from '@sportkarta/db';
import { config } from 'dotenv';

/**
 * Shared harness for the journey suites: the app's OWN functions — the ones the
 * server actions call — run against real PostGIS.
 *
 * Why these exist at all: every other test of these flows either fakes the
 * database (tests/contributions.test.ts and friends answer from a scripted
 * queue, so none of their SQL ever runs) or runs a hand-copied twin of the
 * statements (db/src/*-authz.test.ts). A wrong column, a migration that
 * changed a constraint under a query, or a typo in sign-up, contribution,
 * RSVP, check-in, moderation or erasure SQL passed all of them. These call
 * the real functions, so drift has nowhere to hide.
 *
 * Integration tests against the dev/CI database; they skip without
 * DATABASE_URL (the quality job) and run in CI's db-tests job.
 */

// Repo-root .env, as db/vitest.config.ts loads it: a developer with the dev
// database up runs these too. dotenv never overrides, so `DATABASE_URL= pnpm
// test` still skips them.
config({ path: '../../.env' });

export const hasDb = Boolean(process.env.DATABASE_URL);

type Db = ReturnType<typeof getDb>;
/** The transaction every journey runs in — what the app's functions receive as `db`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Thrown to end a journey; never escapes `journey()`. */
class Rollback extends Error {}

/**
 * Run one journey inside a transaction that is ALWAYS rolled back.
 *
 * The app's functions open their own transactions; inside this one drizzle
 * turns each into a SAVEPOINT, so they run exactly the statements they run in
 * production and every trigger, CHECK and foreign key fires (none in the schema
 * is DEFERRABLE). Nothing is left behind, which matters twice over:
 * facility_edits and moderation_decisions are append-only, so a committed
 * fixture facility could never be deleted again and would drift /statistika in
 * the shared database for good; and journeys running side by side cannot see
 * each other's rows.
 *
 * The one thing that differs from production, stated so nobody trips on it:
 * `now()` is the transaction's start for every statement, so a journey sees a
 * single frozen database clock.
 */
export async function journey(run: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await getDb().transaction(async (tx) => {
      await run(tx);
      throw new Rollback('journey complete');
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

/** For afterAll: one pool per test file (vitest isolates modules per file). */
export async function closePool(): Promise<void> {
  await getPool().end();
}

/** First row of a query, or undefined. */
export async function one<T extends Record<string, unknown> = Record<string, unknown>>(
  tx: Tx,
  query: SQL,
): Promise<T | undefined> {
  const result = await tx.execute(query);
  return result.rows[0] as T | undefined;
}

/** The address a journey account signs in with. */
export function emailOf(userId: string): string {
  return `${userId}@example.org`;
}

/** A fresh account, unique per call so journeys in parallel never collide. */
export async function makeUser(
  tx: Tx,
  label: string,
  role: 'user' | 'ambassador' | 'admin' = 'user',
): Promise<string> {
  const id = `journey_${label}_${randomUUID().slice(0, 8)}`;
  await tx.execute(sql`
    INSERT INTO users (id, display_name, email, role)
    VALUES (${id}, ${`Journey ${label}`}, ${emailOf(id)}, ${role}::user_role)
  `);
  return id;
}

/**
 * A pin inside Stolichna — a seed municipality in CI, the real boundary after
 * an OSM import — jittered so that no real facility of the same sport sits
 * within the 30 m duplicate radius on a developer's fully imported database.
 */
export function sofiaPin(): { lat: number; lon: number } {
  return { lon: 23.2 + Math.random() * 0.1, lat: 42.6 + Math.random() * 0.1 };
}

/** Plovdiv: far outside every radius a Sofia pin is judged by. */
export const FAR_AWAY = { lat: 42.15, lon: 24.75 };

/**
 * The Sofia wall clock `interval` after the database's now(), in the
 * `YYYY-MM-DDTHH:MM` form the session form submits.
 */
export async function sofiaWallClock(tx: Tx, interval: string): Promise<string> {
  const row = await one<{ local: string }>(
    tx,
    sql`SELECT to_char((now() + ${interval}::interval) AT TIME ZONE 'Europe/Sofia',
                       'YYYY-MM-DD"T"HH24:MI') AS local`,
  );
  return String(row?.local);
}

/**
 * The series' first occurrence, written the way the materializer writes it:
 * the instant derived from the wall clock in the series' own zone, so the
 * local-clock trigger (0008) agrees. Materialization itself is proven by
 * db/src/sessions-materialize.test.ts; journeys need an occurrence, not a job.
 */
export async function firstOccurrence(tx: Tx, sessionId: string): Promise<string> {
  const row = await one<{ id: string }>(
    tx,
    sql`
      INSERT INTO play_session_occurrences (session_id, starts_at, ends_at, starts_at_local)
      SELECT s.id,
             s.starts_at_local AT TIME ZONE s.timezone,
             (s.starts_at_local AT TIME ZONE s.timezone) + make_interval(mins => s.duration_minutes),
             s.starts_at_local
        FROM play_sessions s
       WHERE s.id = ${sessionId}::uuid
      RETURNING id
    `,
  );
  return String(row?.id);
}

/** An existing, live facility and where it is. */
export async function aFacility(tx: Tx): Promise<{ id: string; lat: number; lon: number }> {
  const row = await one<{ id: string; lat: number; lon: number }>(
    tx,
    sql`SELECT id, ST_Y(geom) AS lat, ST_X(geom) AS lon FROM facilities
         WHERE status <> 'gone' ORDER BY created_at, id LIMIT 1`,
  );
  if (!row) throw new Error('fixture: the database holds no facility (was it seeded?)');
  return { id: String(row.id), lat: Number(row.lat), lon: Number(row.lon) };
}

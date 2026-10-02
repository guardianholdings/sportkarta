import { buildExceptionEvent, scrubText } from '@sportkarta/lib/error-report';
import { DrizzleQueryError, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';

/**
 * A failed query must not carry its bound values to GlitchTip.
 *
 * drizzle-orm wraps every failed statement in a DrizzleQueryError whose MESSAGE
 * is `Failed query: <sql>\nparams: <every bound value>`. Those values are a
 * member's display name, the free text of a report, an account id, and the
 * browser coordinates that verify / condition-report / check-in bind so that
 * only `distance_m` is ever stored — and the error reporter
 * (lib/src/error-report) forwards messages from the web app's onRequestError and
 * from every failed worker job.
 *
 * This lives in db/ because it is the one package allowed to import drizzle-orm,
 * and it uses the REAL error, thrown by the real driver path, so a drizzle
 * upgrade that changes the message shape fails here instead of leaking. No
 * database: the client is a stand-in whose every query fails like Postgres.
 */

const NAME = 'Мария Иванова';
const LAT = 42.6977085;
const LON = 23.3219335;
const ACCOUNT = 'Xk2aQ9rT7pLm4ZcV';

function failingClient(cause: Error): pg.Pool {
  return { query: () => Promise.reject(cause) } as unknown as pg.Pool;
}

function pgCheckViolation(): Error {
  return Object.assign(
    new Error('new row for relation "facility_edits" violates check constraint "x"'),
    { name: 'error', code: '23514' },
  );
}

async function failedQuery(): Promise<unknown> {
  const db = drizzle(failingClient(pgCheckViolation()));
  try {
    await db.execute(sql`
      INSERT INTO facility_edits (facility_id, actor, field, new_value)
      SELECT f.id, ${ACCOUNT}, 'name', ${JSON.stringify(NAME)}::jsonb FROM facilities f
      WHERE ST_DWithin(f.geom::geography,
                       ST_SetSRID(ST_MakePoint(${LON}, ${LAT}), 4326)::geography, 100)
    `);
  } catch (error) {
    return error;
  }
  throw new Error('expected the query to fail');
}

describe('a failed drizzle query, reported', () => {
  it('is a DrizzleQueryError that prints its parameters (why the scrubber exists)', async () => {
    const error = await failedQuery();
    expect(error).toBeInstanceOf(DrizzleQueryError);
    const message = (error as Error).message;
    expect(message).toContain(NAME);
    expect(message).toContain(String(LAT));
    expect(message).toMatch(/\nparams: /);
  });

  it('reaches GlitchTip with the SQL and the pg reason, and none of the values', async () => {
    const event = buildExceptionEvent(await failedQuery(), { component: 'web', now: 0 });
    const sent = JSON.stringify(event);

    for (const value of [NAME, ACCOUNT, String(LAT), String(LON)]) {
      expect(sent).not.toContain(value);
    }
    const [cause, thrown] = event.exception?.values ?? [];
    expect(cause?.value).toMatch(/violates check constraint "x"/);
    expect(thrown?.value).toMatch(/^Failed query:\s+INSERT INTO facility_edits/);
    expect(thrown?.value).toMatch(/\nparams: \[redacted\]$/);
  });

  it('is cut the same way wherever its message is quoted', async () => {
    // The admin health page shows a failed job's message from pg-boss's
    // output, which is this same text.
    const message = ((await failedQuery()) as Error).message;
    expect(scrubText(`job failed: ${message}`)).not.toContain(NAME);
  });
});

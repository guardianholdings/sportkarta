import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Municipality scoping, proven AT THE QUERY LAYER (docs/ROADMAP.md §5, Stage
 * 3.3: "an ambassador attempting an out-of-scope action must fail at the query
 * layer").
 *
 * These tests deliberately bypass the application entirely and run the same
 * statements the app runs, straight against Postgres. If the scope lived in an
 * `if` in TypeScript, every one of them would pass while the guarantee was
 * worthless; because it lives in the WHERE clause, an out-of-scope decision
 * updates zero rows even with no application code in the picture at all.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

const VARNA_AMBASSADOR = 'e2e_authz_varna';
const SOFIA_AMBASSADOR = 'e2e_authz_sofia';
const SCOPELESS_AMBASSADOR = 'e2e_authz_scopeless';
const ADMIN = 'e2e_authz_admin';

describe.skipIf(!hasDb)('moderation scope (requires running database)', () => {
  let client: pg.Client;
  let varnaId: number;
  let sofiaId: number;
  let varnaFacility: string;
  let sofiaFacility: string;
  let sofiaPhoto: string;
  let sofiaReport: string;
  /** Original statuses, restored in cleanup — see the note in beforeAll. */
  const originalStatus = new Map<string, string>();

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    // Two municipalities that actually have a facility, and one facility from
    // each. Existing rows are BORROWED rather than created: a facility cannot be
    // cleaned up once a moderation_decisions row references it (RESTRICT, and
    // the log is append-only), and leaving extra rows behind would drift the
    // statistics materialised views that db/src/stats-reconcile.test.ts checks.
    const picked = await client.query<{ id: string; municipality_id: number; status: string }>(
      `SELECT DISTINCT ON (municipality_id) id, municipality_id, status
         FROM facilities
        WHERE municipality_id IS NOT NULL
        ORDER BY municipality_id, id
        LIMIT 2`,
    );
    const first = picked.rows[0];
    const second = picked.rows[1];
    if (!first || !second) throw new Error('need two facilities in distinct municipalities');

    varnaId = first.municipality_id;
    sofiaId = second.municipality_id;
    varnaFacility = first.id;
    sofiaFacility = second.id;
    originalStatus.set(first.id, first.status);
    originalStatus.set(second.id, second.status);
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  beforeEach(async () => {
    await cleanup();

    for (const [id, email, role] of [
      [VARNA_AMBASSADOR, 'varna@example.org', 'ambassador'],
      [SOFIA_AMBASSADOR, 'sofia@example.org', 'ambassador'],
      [SCOPELESS_AMBASSADOR, 'scopeless@example.org', 'ambassador'],
      [ADMIN, 'authz-admin@example.org', 'admin'],
    ]) {
      await client.query(
        `INSERT INTO users (id, display_name, email, role) VALUES ($1, 'Тест', $2, $3::user_role)`,
        [id, email, role],
      );
    }
    await client.query(
      `INSERT INTO ambassador_municipalities (user_id, municipality_id) VALUES ($1, $2), ($3, $4)`,
      [VARNA_AMBASSADOR, varnaId, SOFIA_AMBASSADOR, sofiaId],
    );

    // Put the borrowed facilities into the state under test.
    await client.query(
      `UPDATE facilities SET status = 'needs_verification' WHERE id = ANY($1::uuid[])`,
      [[varnaFacility, sofiaFacility]],
    );

    sofiaPhoto = (
      await client.query<{ id: string }>(
        `INSERT INTO facility_photos (facility_id, storage_path, status)
         VALUES ($1::uuid, $2, 'pending') RETURNING id`,
        [sofiaFacility, `photos/authz-${Date.now()}.webp`],
      )
    ).rows[0]?.id as string;

    sofiaReport = (
      await client.query<{ id: string }>(
        `INSERT INTO facility_reports (facility_id, issue, status)
         VALUES ($1::uuid, 'other', 'pending') RETURNING id`,
        [sofiaFacility],
      )
    ).rows[0]?.id as string;
  });

  async function cleanup(): Promise<void> {
    await client.query(`DELETE FROM facility_photos WHERE storage_path LIKE 'photos/authz-%'`);
    await client.query(
      `DELETE FROM facility_reports WHERE facility_id = ANY($1::uuid[]) AND issue = 'other'`,
      [[varnaFacility, sofiaFacility].filter(Boolean)],
    );
    // Hand the borrowed facilities back exactly as they were.
    for (const [id, status] of originalStatus) {
      await client.query(`UPDATE facilities SET status = $2::facility_status WHERE id = $1::uuid`, [
        id,
        status,
      ]);
    }
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [
      [VARNA_AMBASSADOR, SOFIA_AMBASSADOR, SCOPELESS_AMBASSADOR, ADMIN],
    ]);
  }

  /** The production scope predicate, verbatim. */
  function scope(actor: string, isAdmin = false): string {
    return isAdmin
      ? 'TRUE'
      : `f.municipality_id IN (SELECT municipality_id FROM ambassador_municipalities
                                WHERE user_id = ${quote(actor)})`;
  }

  function quote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  async function decidePhoto(actor: string, photoId: string, isAdmin = false): Promise<number> {
    const result = await client.query(
      `UPDATE facility_photos p SET status = 'approved'
         FROM facilities f
        WHERE p.id = $1::uuid AND f.id = p.facility_id AND p.status = 'pending'
          AND ${scope(actor, isAdmin)}`,
      [photoId],
    );
    return result.rowCount ?? 0;
  }

  async function resolveReport(actor: string, reportId: string, isAdmin = false): Promise<number> {
    const result = await client.query(
      `UPDATE facility_reports r SET status = 'reviewed'
         FROM facilities f
        WHERE r.id = $1::uuid AND f.id = r.facility_id AND r.status = 'pending'
          AND ${scope(actor, isAdmin)}`,
      [reportId],
    );
    return result.rowCount ?? 0;
  }

  async function decideFacility(
    actor: string,
    facilityId: string,
    isAdmin = false,
  ): Promise<number> {
    const result = await client.query(
      `UPDATE facilities f SET status = 'active'
        WHERE f.id = $1::uuid AND f.status = 'needs_verification'
          AND ${scope(actor, isAdmin)}`,
      [facilityId],
    );
    return result.rowCount ?? 0;
  }

  it('refuses an out-of-scope photo decision at the query layer', async () => {
    // The Varna ambassador reaching for a Sofia photo: zero rows, no error, no
    // decision — the statement simply matches nothing.
    expect(await decidePhoto(VARNA_AMBASSADOR, sofiaPhoto)).toBe(0);
    const after = await client.query<{ status: string }>(
      `SELECT status FROM facility_photos WHERE id = $1::uuid`,
      [sofiaPhoto],
    );
    expect(after.rows[0]?.status).toBe('pending');
  });

  it('refuses an out-of-scope report decision at the query layer', async () => {
    expect(await resolveReport(VARNA_AMBASSADOR, sofiaReport)).toBe(0);
    const after = await client.query<{ status: string }>(
      `SELECT status FROM facility_reports WHERE id = $1::uuid`,
      [sofiaReport],
    );
    expect(after.rows[0]?.status).toBe('pending');
  });

  it('refuses an out-of-scope facility verification at the query layer', async () => {
    expect(await decideFacility(VARNA_AMBASSADOR, sofiaFacility)).toBe(0);
    const after = await client.query<{ status: string }>(
      `SELECT status FROM facilities WHERE id = $1::uuid`,
      [sofiaFacility],
    );
    expect(after.rows[0]?.status).toBe('needs_verification');
  });

  it('allows the same decisions inside the ambassador’s own municipality', async () => {
    expect(await decidePhoto(SOFIA_AMBASSADOR, sofiaPhoto)).toBe(1);
    expect(await resolveReport(SOFIA_AMBASSADOR, sofiaReport)).toBe(1);
    expect(await decideFacility(SOFIA_AMBASSADOR, sofiaFacility)).toBe(1);
  });

  it('gives a scopeless ambassador no power anywhere', async () => {
    // The fail-closed default: the role alone decides nothing.
    expect(await decidePhoto(SCOPELESS_AMBASSADOR, sofiaPhoto)).toBe(0);
    expect(await resolveReport(SCOPELESS_AMBASSADOR, sofiaReport)).toBe(0);
    expect(await decideFacility(SCOPELESS_AMBASSADOR, varnaFacility)).toBe(0);
  });

  it('loses power the moment the municipality is revoked', async () => {
    await client.query(
      `DELETE FROM ambassador_municipalities WHERE user_id = $1 AND municipality_id = $2`,
      [SOFIA_AMBASSADOR, sofiaId],
    );
    expect(await decidePhoto(SOFIA_AMBASSADOR, sofiaPhoto)).toBe(0);
  });

  it('lets an admin decide anywhere', async () => {
    expect(await decidePhoto(ADMIN, sofiaPhoto, true)).toBe(1);
    expect(await decideFacility(ADMIN, varnaFacility, true)).toBe(1);
  });

  it('keeps the decision log append-only', async () => {
    await client.query(
      `INSERT INTO moderation_decisions
         (actor_id, target_type, target_id, facility_id, municipality_id, decision, queued_at)
       VALUES ($1, 'photo', $2::uuid, $3::uuid, $4, 'approved', now())`,
      [SOFIA_AMBASSADOR, sofiaPhoto, sofiaFacility, sofiaId],
    );
    await expect(
      client.query(`UPDATE moderation_decisions SET decision = 'rejected' WHERE actor_id = $1`, [
        SOFIA_AMBASSADOR,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      client.query(`DELETE FROM moderation_decisions WHERE actor_id = $1`, [SOFIA_AMBASSADOR]),
    ).rejects.toThrow(/append-only/);

    // And it survives the moderator erasing their account: no FK, by design.
    await client.query(`DELETE FROM users WHERE id = $1`, [SOFIA_AMBASSADOR]);
    const surviving = await client.query(`SELECT 1 FROM moderation_decisions WHERE actor_id = $1`, [
      SOFIA_AMBASSADOR,
    ]);
    // Rows from earlier runs are still here too — that is the point of an
    // append-only log, so this asserts survival rather than an exact count.
    expect(surviving.rowCount ?? 0).toBeGreaterThan(0);
  });

  it('revokes the scope when the account is erased', async () => {
    await client.query(`DELETE FROM users WHERE id = $1`, [VARNA_AMBASSADOR]);
    const scopeRows = await client.query(
      `SELECT 1 FROM ambassador_municipalities WHERE user_id = $1`,
      [VARNA_AMBASSADOR],
    );
    expect(scopeRows.rowCount).toBe(0);
  });

  it('forbids the retired moderator role', async () => {
    await expect(
      client.query(`UPDATE users SET role = 'moderator' WHERE id = $1`, [VARNA_AMBASSADOR]),
    ).rejects.toThrow(/users_role_not_moderator/);
  });
});

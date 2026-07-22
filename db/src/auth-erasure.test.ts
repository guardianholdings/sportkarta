import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * GDPR erasure and audit integrity, proven against real Postgres — the
 * constraints, cascades and append-only triggers are the guarantee, and this
 * test is what keeps them honest (docs/ROADMAP.md §5).
 *
 * Integration test against the dev/CI database (compose.dev.yml); skips itself
 * when no DATABASE_URL is configured.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

const USER_ID = 'e2e_erasure_user';
const OTHER_USER_ID = 'e2e_erasure_other';

describe.skipIf(!hasDb)('account erasure (requires running database)', () => {
  let client: pg.Client;
  // Attaches to a seeded facility rather than creating one: facility_edits is
  // append-only and references facilities ON DELETE RESTRICT, so a fixture
  // facility could never be cleaned up and would skew /statistika forever.
  let facilityId: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const facility = await client.query<{ id: string }>(
      `SELECT id FROM facilities ORDER BY created_at, id LIMIT 1`,
    );
    facilityId = facility.rows[0]?.id ?? '';
    await seed();
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  async function seed(): Promise<void> {
    await cleanup();
    for (const [id, email] of [
      [USER_ID, 'erasure@example.org'],
      [OTHER_USER_ID, 'other@example.org'],
    ]) {
      await client.query(`INSERT INTO users (id, display_name, email) VALUES ($1, $2, $3)`, [
        id,
        'Тест',
        email,
      ]);
    }
    await client.query(
      `INSERT INTO sessions (id, user_id, token, expires_at)
       VALUES ('e2e_erasure_session', $1, 'e2e-erasure-token', now() + interval '1 day')`,
      [USER_ID],
    );
    await client.query(
      `INSERT INTO accounts (id, user_id, account_id, provider_id)
       VALUES ('e2e_erasure_account', $1, 'google-123', 'google')`,
      [USER_ID],
    );
    await client.query(
      `INSERT INTO verifications (id, identifier, value, expires_at)
       VALUES ('e2e_erasure_verification', 'sign-in-otp-erasure@example.org', 'hash',
               now() + interval '10 minutes')`,
    );
    await client.query(
      `INSERT INTO facility_photos (id, facility_id, storage_path, uploaded_by)
       VALUES (gen_random_uuid(), $1::uuid, 'photos/e2e-erasure.webp', $2)`,
      [facilityId, USER_ID],
    );
    await client.query(
      `INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
       VALUES ($1::uuid, $2, 'crowd', 'status', '"needs_verification"'::jsonb, '"active"'::jsonb)`,
      [facilityId, USER_ID],
    );
  }

  async function cleanup(): Promise<void> {
    // facility_edits rows are append-only and stay: they are the audit trail
    // (the assertions below account for rows left by previous runs).
    await client.query(
      `DELETE FROM facility_photos WHERE storage_path = 'photos/e2e-erasure.webp'`,
    );
    await client.query(`DELETE FROM verifications WHERE id = 'e2e_erasure_verification'`);
    await client.query(`DELETE FROM account_deletions WHERE user_id = ANY($1::text[])`, [
      [USER_ID, OTHER_USER_ID],
    ]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[USER_ID, OTHER_USER_ID]]);
  }

  async function count(query: string, params: unknown[] = []): Promise<number> {
    const result = await client.query<{ n: string }>(query, params);
    return Number(result.rows[0]?.n ?? 0);
  }

  it('erases the profile and everything that identifies the person', async () => {
    const auditBefore = await count(`SELECT count(*) AS n FROM facility_edits WHERE actor = $1`, [
      USER_ID,
    ]);
    expect(auditBefore).toBeGreaterThan(0);

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO account_deletions (user_id, audit_rows_preserved, photos_anonymized)
       VALUES ($1, $2, 1)`,
      [USER_ID, auditBefore],
    );
    await client.query(
      `DELETE FROM verifications v USING users u
       WHERE u.id = $1
         AND (v.identifier = u.email OR right(v.identifier, char_length(u.email) + 5) = '-otp-' || u.email)`,
      [USER_ID],
    );
    await client.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
    await client.query('COMMIT');

    expect(await count(`SELECT count(*) AS n FROM users WHERE id = $1`, [USER_ID])).toBe(0);
    // Cascades: no session or OAuth account outlives the profile.
    expect(await count(`SELECT count(*) AS n FROM sessions WHERE user_id = $1`, [USER_ID])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM accounts WHERE user_id = $1`, [USER_ID])).toBe(0);
    // The pending one-time code, which is keyed by email, is gone too.
    expect(
      await count(`SELECT count(*) AS n FROM verifications WHERE id = 'e2e_erasure_verification'`),
    ).toBe(0);
  });

  it('anonymises contributions instead of deleting them', async () => {
    const photo = await client.query<{ uploaded_by: string | null }>(
      `SELECT uploaded_by FROM facility_photos WHERE storage_path = 'photos/e2e-erasure.webp'`,
    );
    // The photo is still on the map; the uploader reference is not.
    expect(photo.rowCount).toBe(1);
    expect(photo.rows[0]?.uploaded_by).toBeNull();
  });

  it('preserves the audit trail exactly as written', async () => {
    const rows = await client.query<{ actor: string; new_value: unknown }>(
      `SELECT actor, new_value FROM facility_edits WHERE actor = $1`,
      [USER_ID],
    );
    // Rows survive the erasure with the opaque actor id intact — what is
    // destroyed is the mapping from that id to a person.
    expect(rows.rowCount).toBeGreaterThan(0);
    expect(rows.rows[0]?.actor).toBe(USER_ID);
    expect(await count(`SELECT count(*) AS n FROM users WHERE id = $1`, [USER_ID])).toBe(0);

    // A tombstone records that the erasure happened, with no personal data.
    const tombstone = await client.query<{ audit_rows_preserved: number }>(
      `SELECT audit_rows_preserved FROM account_deletions WHERE user_id = $1`,
      [USER_ID],
    );
    expect(tombstone.rowCount).toBe(1);
    expect(tombstone.rows[0]?.audit_rows_preserved).toBeGreaterThan(0);
  });

  it('refuses to rewrite or delete an audit row', async () => {
    await expect(
      client.query(`UPDATE facility_edits SET actor = 'someone-else' WHERE actor = $1`, [USER_ID]),
    ).rejects.toThrow(/append-only/);
    await expect(
      client.query(`DELETE FROM facility_edits WHERE actor = $1`, [USER_ID]),
    ).rejects.toThrow(/append-only/);
  });
});

describe.skipIf(!hasDb)('auth schema privacy invariants (requires running database)', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.query(`DELETE FROM users WHERE id = 'e2e_invariant_user'`);
    await client.end();
  });

  it('stores no date of birth anywhere in the schema', async () => {
    const result = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (column_name ~* '(dob|birth)' OR column_name = 'date_of_birth')`,
    );
    expect(result.rows).toEqual([]);
  });

  it('rejects any attempt to persist a session IP address', async () => {
    await client.query(
      `INSERT INTO users (id, display_name, email) VALUES ('e2e_invariant_user', 'Тест', 'invariant@example.org')
       ON CONFLICT (id) DO NOTHING`,
    );
    await expect(
      client.query(
        `INSERT INTO sessions (id, user_id, token, expires_at, ip_address)
         VALUES ('e2e_invariant_session', 'e2e_invariant_user', 'e2e-invariant-token',
                 now() + interval '1 day', '203.0.113.7')`,
      ),
    ).rejects.toThrow(/sessions_no_ip_stored/);
  });

  it('keeps email addresses unique and lowercase', async () => {
    await expect(
      client.query(
        `INSERT INTO users (id, display_name, email) VALUES ('e2e_invariant_upper', 'Тест', 'Mixed@Example.org')`,
      ),
    ).rejects.toThrow(/users_email_lowercase/);
  });
});

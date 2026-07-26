import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The minor boundary, proven AT THE QUERY LAYER (Stage 5.1) — the same
 * discipline as db/src/moderation-authz.test.ts.
 *
 * CLAUDE.md: "Minors: no individual public leaderboards". A publicly readable
 * page of one named child's sporting habits is that exposure by another route,
 * so the rule is a CHECK constraint and not an `if` in a server action. These
 * tests bypass the application entirely and run the statements straight against
 * Postgres: if the guarantee lived in TypeScript they would all pass while
 * being worthless.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

const ADULT = 'e2e_passport_adult';
const MINOR = 'e2e_passport_minor';
const HANDLE_A = 'a1b2c3d4e5f60718293a4b5c';
const HANDLE_B = '0f1e2d3c4b5a69788796a5b4';

describe.skipIf(!hasDb)('passport visibility constraints (requires running database)', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  async function cleanup(): Promise<void> {
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[ADULT, MINOR]]);
  }

  beforeEach(async () => {
    await cleanup();
    await client.query(
      `INSERT INTO users (id, display_name, email, is_minor)
       VALUES ($1, 'Възрастен', 'passport-adult@example.org', false),
              ($2, 'Непълнолетен', 'passport-minor@example.org', true)`,
      [ADULT, MINOR],
    );
  });

  it('defaults every member to private with no handle', async () => {
    const result = await client.query(
      `SELECT profile_visibility, public_handle, public_show_activity FROM users WHERE id = $1`,
      [ADULT],
    );
    expect(result.rows[0]).toMatchObject({
      profile_visibility: 'private',
      public_handle: null,
      public_show_activity: false,
    });
  });

  it('lets an adult publish', async () => {
    await client.query(
      `UPDATE users SET profile_visibility = 'public', public_handle = $2 WHERE id = $1`,
      [ADULT, HANDLE_A],
    );
    const result = await client.query(
      `SELECT profile_visibility FROM users WHERE id = $1 AND public_handle = $2`,
      [ADULT, HANDLE_A],
    );
    expect(result.rows[0]?.profile_visibility).toBe('public');
  });

  it('REFUSES to publish a minor, with the application bypassed entirely', async () => {
    await expect(
      client.query(
        `UPDATE users SET profile_visibility = 'public', public_handle = $2 WHERE id = $1`,
        [MINOR, HANDLE_A],
      ),
    ).rejects.toThrow(/users_minor_profile_not_public/);
  });

  it('REFUSES to mark an already-public member as a minor', async () => {
    await client.query(
      `UPDATE users SET profile_visibility = 'public', public_handle = $2 WHERE id = $1`,
      [ADULT, HANDLE_A],
    );
    // This is the direction apps/web/lib/profile.ts handles by demoting to
    // private in the same statement. Without that, the database refuses — which
    // is the correct failure, and is why the application does the demotion
    // rather than leaving a member unable to correct their birth date.
    await expect(
      client.query(`UPDATE users SET is_minor = true WHERE id = $1`, [ADULT]),
    ).rejects.toThrow(/users_minor_profile_not_public/);
  });

  it('accepts the demotion the application performs in one statement', async () => {
    await client.query(
      `UPDATE users SET profile_visibility = 'public', public_handle = $2 WHERE id = $1`,
      [ADULT, HANDLE_A],
    );
    await client.query(
      `UPDATE users SET is_minor = true, profile_visibility = 'private' WHERE id = $1`,
      [ADULT],
    );
    const result = await client.query(
      `SELECT is_minor, profile_visibility, public_handle FROM users WHERE id = $1`,
      [ADULT],
    );
    // The handle survives the demotion — it grants nothing while private, and
    // keeping it means a member who turns out to be an adult after all does not
    // lose the link they had shared.
    expect(result.rows[0]).toMatchObject({
      is_minor: true,
      profile_visibility: 'private',
      public_handle: HANDLE_A,
    });
  });

  it('refuses a public profile with no handle — public and unreachable', async () => {
    await expect(
      client.query(`UPDATE users SET profile_visibility = 'public' WHERE id = $1`, [ADULT]),
    ).rejects.toThrow(/users_public_needs_handle/);
  });

  it('refuses a handle that is not the full random shape', async () => {
    for (const bad of ['short', 'A1B2C3D4E5F60718293A4B5C', 'a1b2c3d4e5f60718293a4b5c9', '']) {
      await expect(
        client.query(`UPDATE users SET public_handle = $2 WHERE id = $1`, [ADULT, bad]),
      ).rejects.toThrow(/users_public_handle_shape/);
    }
  });

  it('refuses two members sharing a handle', async () => {
    await client.query(
      `UPDATE users SET profile_visibility = 'public', public_handle = $2 WHERE id = $1`,
      [ADULT, HANDLE_A],
    );
    await expect(
      client.query(`UPDATE users SET public_handle = $2 WHERE id = $1`, [MINOR, HANDLE_A]),
    ).rejects.toThrow(/users_public_handle_unique/);
  });

  it('does not block GDPR erasure of a public member', async () => {
    // The 0009 lesson: a CHECK that has to re-validate during erasure aborts
    // DELETE FROM users forever. `users` is never the referencing side of an
    // FK, so these constraints never run here — asserted rather than assumed.
    await client.query(
      `UPDATE users SET profile_visibility = 'public', public_handle = $2 WHERE id = $1`,
      [ADULT, HANDLE_B],
    );
    await client.query(
      `INSERT INTO user_badges (user_id, badge_slug, earned_at)
       VALUES ($1, 'first_contribution', now())`,
      [ADULT],
    );
    await expect(client.query(`DELETE FROM users WHERE id = $1`, [ADULT])).resolves.toBeDefined();

    const badges = await client.query(`SELECT count(*)::int AS n FROM user_badges WHERE user_id = $1`, [
      ADULT,
    ]);
    expect(badges.rows[0]?.n).toBe(0);
  });
});

describe.skipIf(!hasDb)('user_badges constraints (requires running database)', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query(`DELETE FROM users WHERE id = $1`, [ADULT]);
    await client.query(
      `INSERT INTO users (id, display_name, email) VALUES ($1, 'Възрастен', 'badge-owner@example.org')`,
      [ADULT],
    );
  });

  afterAll(async () => {
    await client.query(`DELETE FROM users WHERE id = $1`, [ADULT]);
    await client.end();
  });

  it('awards a badge once, however many times it is observed', async () => {
    const insert = `INSERT INTO user_badges (user_id, badge_slug, earned_at)
                    VALUES ($1, 'mapper_5', now())
                    ON CONFLICT (user_id, badge_slug) DO NOTHING
                    RETURNING id`;
    const first = await client.query(insert, [ADULT]);
    const second = await client.query(insert, [ADULT]);
    expect(first.rowCount).toBe(1);
    // The idempotency guarantee the passport page depends on: a second page
    // load must not congratulate the member again.
    expect(second.rowCount).toBe(0);
  });

  it('refuses a slug the config validator would also refuse', async () => {
    for (const bad of ['Първа', 'X_BADGE', '_leading', 'ab']) {
      await expect(
        client.query(
          `INSERT INTO user_badges (user_id, badge_slug, earned_at) VALUES ($1, $2, now())`,
          [ADULT, bad],
        ),
      ).rejects.toThrow(/user_badges_slug_shape/);
    }
  });

  it('refuses a badge earned after it was first seen', async () => {
    await expect(
      client.query(
        `INSERT INTO user_badges (user_id, badge_slug, earned_at, first_seen_at)
         VALUES ($1, 'regular_10', now() + interval '1 day', now())`,
        [ADULT],
      ),
    ).rejects.toThrow(/user_badges_earned_before_seen/);
  });

  it('refuses a badge seen before it was first observed', async () => {
    await expect(
      client.query(
        `INSERT INTO user_badges (user_id, badge_slug, earned_at, first_seen_at, seen_at)
         VALUES ($1, 'first_game', now(), now(), now() - interval '1 day')`,
        [ADULT],
      ),
    ).rejects.toThrow(/user_badges_seen_order/);
  });
});

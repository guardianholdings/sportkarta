import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Account suspension and the `admin_actions` log (0033), proven AGAINST REAL
 * POSTGRES — the CHECKs, the append-only triggers and the absence of foreign
 * keys are the guarantee; apps/web/tests/account-controls.test.ts only proves
 * that the application sends the statements that rely on them.
 *
 * What must hold:
 *  - a suspended account cannot hold a public passport, so it can never appear
 *    in `leaderboard_eligible_members` (every public board reads that view);
 *  - a suspension always has a reason and a lifted one never keeps it;
 *  - `admin_actions` is append-only, cannot carry a non-object or oversized
 *    `detail`, names an account for every account action and none for the two
 *    national switches;
 *  - erasing an account does not take the record of what was done to it.
 *
 * FIXTURE HYGIENE. `admin_actions` is append-only, so a committed test row
 * would sit in the dev database's real accountability log forever and show on
 * /admin/chastni as a switch nobody made. Every statement that writes to it
 * therefore runs inside a transaction that is ROLLED BACK — which also means an
 * expected failure must be the LAST statement of its transaction (Postgres
 * aborts the rest). The users row is ordinary and is cleaned up normally; its
 * id, email and handle are unique per run so a crashed earlier run cannot
 * collide with this one.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

const RUN = randomBytes(4).toString('hex');
const MEMBER = `e2e_suspension_member_${RUN}`;
const ADMIN = `e2e_suspension_admin_${RUN}`;
const EMAIL = `suspension-${RUN}@example.org`;
const HANDLE = randomBytes(12).toString('hex');

describe.skipIf(!hasDb)('account suspension and admin_actions (requires running database)', () => {
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
    await client.query(`DELETE FROM users WHERE id = $1`, [MEMBER]);
  }

  beforeEach(async () => {
    await cleanup();
    // A member with a PUBLIC passport — the state a suspension has to undo.
    await client.query(
      `INSERT INTO users (id, display_name, email, profile_visibility, public_handle)
       VALUES ($1, 'Обидно име', $2, 'public', $3)`,
      [MEMBER, EMAIL, HANDLE],
    );
  });

  /** Run `body` in a transaction that never commits. */
  async function rolledBack(body: () => Promise<void>): Promise<void> {
    await client.query('BEGIN');
    try {
      await body();
    } finally {
      await client.query('ROLLBACK');
    }
  }

  async function eligible(): Promise<number> {
    const result = await client.query(
      `SELECT count(*)::int AS n FROM leaderboard_eligible_members WHERE id = $1`,
      [MEMBER],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  describe('users.suspended_at', () => {
    it('suspends in one statement, and the name leaves every public board at once', async () => {
      expect(await eligible()).toBe(1);

      // The statement lib/account-controls.ts suspendAccount sends.
      await client.query(
        `UPDATE users
         SET suspended_at = now(), suspended_reason = $2, profile_visibility = 'private',
             updated_at = now()
         WHERE id = $1`,
        [MEMBER, 'спам в редакциите'],
      );

      expect(await eligible()).toBe(0);
      const row = await client.query(
        `SELECT suspended_reason, profile_visibility, public_handle FROM users WHERE id = $1`,
        [MEMBER],
      );
      // The handle is kept, like the member's own "go private", so a link they
      // shared works again if they re-publish after the suspension is lifted.
      expect(row.rows[0]).toMatchObject({
        suspended_reason: 'спам в редакциите',
        profile_visibility: 'private',
        public_handle: HANDLE,
      });
    });

    it('cannot leave a suspended account public — not by forgetting, not afterwards', async () => {
      await expect(
        client.query(
          `UPDATE users SET suspended_at = now(), suspended_reason = 'x' WHERE id = $1`,
          [MEMBER],
        ),
      ).rejects.toThrow(/users_suspended_is_private/);

      await client.query(
        `UPDATE users SET suspended_at = now(), suspended_reason = 'x',
                          profile_visibility = 'private'
         WHERE id = $1`,
        [MEMBER],
      );
      // A "go public" racing the suspension, or any future writer, is refused.
      await expect(
        client.query(`UPDATE users SET profile_visibility = 'public' WHERE id = $1`, [MEMBER]),
      ).rejects.toThrow(/users_suspended_is_private/);
    });

    it('treats a suspended account as absent to the getCurrentUser lookup', async () => {
      const lookup = `SELECT id FROM users WHERE id = $1 AND suspended_at IS NULL`;
      expect((await client.query(lookup, [MEMBER])).rows).toHaveLength(1);
      await client.query(
        `UPDATE users SET suspended_at = now(), suspended_reason = 'x',
                          profile_visibility = 'private'
         WHERE id = $1`,
        [MEMBER],
      );
      expect((await client.query(lookup, [MEMBER])).rows).toHaveLength(0);
    });

    it('pairs the suspension with its reason, both ways', async () => {
      await expect(
        client.query(
          `UPDATE users SET suspended_at = now(), profile_visibility = 'private' WHERE id = $1`,
          [MEMBER],
        ),
      ).rejects.toThrow(/users_suspension_pair/);
      await expect(
        client.query(`UPDATE users SET suspended_reason = 'x' WHERE id = $1`, [MEMBER]),
      ).rejects.toThrow(/users_suspension_pair/);

      // Lifting clears both together, and re-publishes nothing.
      await client.query(
        `UPDATE users SET suspended_at = now(), suspended_reason = 'x',
                          profile_visibility = 'private'
         WHERE id = $1`,
        [MEMBER],
      );
      await expect(
        client.query(`UPDATE users SET suspended_at = NULL WHERE id = $1`, [MEMBER]),
      ).rejects.toThrow(/users_suspension_pair/);
      await client.query(
        `UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = $1`,
        [MEMBER],
      );
      expect(await eligible()).toBe(0);
    });

    it('refuses a blank or overlong reason', async () => {
      for (const reason of ['   ', 'x'.repeat(301)]) {
        await expect(
          client.query(
            `UPDATE users SET suspended_at = now(), suspended_reason = $2,
                              profile_visibility = 'private'
             WHERE id = $1`,
            [MEMBER, reason],
          ),
        ).rejects.toThrow(/users_suspended_reason_sane/);
      }
      // 300 characters exactly is the form's limit and the column's.
      await client.query(
        `UPDATE users SET suspended_at = now(), suspended_reason = $2,
                          profile_visibility = 'private'
         WHERE id = $1`,
        [MEMBER, 'я'.repeat(300)],
      );
    });
  });

  describe('admin_actions', () => {
    async function insert(
      action: string,
      subjectId: string | null,
      detail = '{}',
    ): Promise<pg.QueryResult> {
      return client.query(
        `INSERT INTO admin_actions (actor_id, action, subject_id, detail)
         VALUES ($1, $2::admin_action, $3, $4::jsonb)
         RETURNING id`,
        [ADMIN, action, subjectId, detail],
      );
    }

    it('is append-only: no update, no delete, no truncate', async () => {
      await rolledBack(async () => {
        await insert('passport_made_private', MEMBER);
        await expect(
          client.query(`UPDATE admin_actions SET actor_id = 'someone_else' WHERE subject_id = $1`, [
            MEMBER,
          ]),
        ).rejects.toThrow(/append-only/);
      });
      await rolledBack(async () => {
        await insert('passport_made_private', MEMBER);
        await expect(
          client.query(`DELETE FROM admin_actions WHERE subject_id = $1`, [MEMBER]),
        ).rejects.toThrow(/append-only/);
      });
      // Inside a transaction that rolls back, so a missing trigger fails this
      // test instead of emptying the log.
      await rolledBack(async () => {
        await expect(client.query(`TRUNCATE admin_actions`)).rejects.toThrow(/append-only/);
      });
    });

    it('survives the erasure of the account it is about — there is no foreign key', async () => {
      await rolledBack(async () => {
        await insert('account_erased', MEMBER);
        await client.query(`DELETE FROM users WHERE id = $1`, [MEMBER]);
        const kept = await client.query(
          `SELECT count(*)::int AS n FROM admin_actions WHERE subject_id = $1`,
          [MEMBER],
        );
        expect(Number(kept.rows[0]?.n)).toBe(1);
      });
    });

    it('names an account for every account action and none for the national switches', async () => {
      await rolledBack(async () => {
        await insert('setting_changed', null, '{"key":"public_show_paid","value":"true"}');
        await insert('business_visibility_changed', null, '{"businessId":1,"visible":false}');
        await insert('sessions_revoked', MEMBER, '{"count":2}');
      });
      await rolledBack(async () => {
        await expect(insert('account_suspended', null)).rejects.toThrow(
          /admin_actions_subject_matches_action/,
        );
      });
      await rolledBack(async () => {
        await expect(insert('setting_changed', MEMBER)).rejects.toThrow(
          /admin_actions_subject_matches_action/,
        );
      });
    });

    it('keeps detail a small object — never a place to park text', async () => {
      await rolledBack(async () => {
        await expect(insert('passport_made_private', MEMBER, '[]')).rejects.toThrow(
          /admin_actions_detail_object/,
        );
      });
      await rolledBack(async () => {
        await expect(
          insert('passport_made_private', MEMBER, JSON.stringify({ note: 'x'.repeat(600) })),
        ).rejects.toThrow(/admin_actions_detail_small/);
      });
    });

    it('refuses a blank actor or subject', async () => {
      await rolledBack(async () => {
        await expect(
          client.query(
            `INSERT INTO admin_actions (actor_id, action, subject_id)
             VALUES ('  ', 'passport_made_private', $1)`,
            [MEMBER],
          ),
        ).rejects.toThrow(/admin_actions_actor_not_blank/);
      });
      await rolledBack(async () => {
        await expect(insert('passport_made_private', ' ')).rejects.toThrow(
          /admin_actions_subject_not_blank/,
        );
      });
    });
  });
});

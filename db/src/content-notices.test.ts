import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  claimModerationNotification,
  decisionMailTarget,
  eraseExpiredNotifierContacts,
  noticeMailTarget,
} from './moderation-mail.js';

/**
 * Notice-and-action and statements of reasons (migration 0034), proven against
 * real Postgres — every guarantee here is a constraint or a trigger, so a unit
 * test with a fake database would prove nothing about it:
 *
 *   - a notice cannot point at a `javascript:` URL, smuggle another host into
 *     a site path, or arrive without its good faith statement;
 *   - what was reported is frozen from arrival, and a decision once taken is
 *     final — only the notifier's contact may be ERASED, never rewritten;
 *   - a reason is a slug, and the PREVIOUS build's reasonless refusal still
 *     lands — the "refusal has a reason" CHECK is 0034's deferred contract step;
 *   - the mail resolves its recipient at send time (an erased account resolves
 *     to nobody), never reads the reported URL, and the ledger lets exactly
 *     one sender through.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

const UPLOADER = 'e2e_notice_uploader';
const ADMIN = 'e2e_notice_admin';
const URL_PREFIX = '/e2e-notice-test/';

interface Runner {
  execute(query: { queryChunks?: unknown }): Promise<{ rows: Record<string, unknown>[] }>;
}

describe.skipIf(!hasDb)('content notices and moderation mail (requires running database)', () => {
  let client: pg.Client;
  let db: Runner;
  let facilityId: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const { drizzle } = await import('drizzle-orm/node-postgres');
    db = drizzle(client) as unknown as Runner;
    // Borrowed, never created: a facility referenced by a moderation decision
    // can never be deleted again (RESTRICT + an append-only log), the same
    // reason moderation-authz.test.ts borrows its facilities.
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
      `INSERT INTO users (id, display_name, email) VALUES ($1, 'Качил', 'uploader@example.test')`,
      [UPLOADER],
    );
  });

  /**
   * Notices refuse DELETE by design, so the test's own rows go the deliberate
   * way the migration documents: the guard disabled inside one transaction.
   */
  async function cleanup(): Promise<void> {
    await client.query('BEGIN');
    try {
      await client.query('ALTER TABLE content_notices DISABLE TRIGGER content_notices_guard_row');
      await client.query(`DELETE FROM content_notices WHERE target_url LIKE $1`, [
        `${URL_PREFIX}%`,
      ]);
      await client.query('ALTER TABLE content_notices ENABLE TRIGGER content_notices_guard_row');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    await client.query(`DELETE FROM facility_photos WHERE storage_path LIKE 'photos/e2e-notice-%'`);
    await client.query(`DELETE FROM users WHERE id = $1`, [UPLOADER]);
  }

  async function notice(overrides: Record<string, string | boolean | null> = {}): Promise<string> {
    const row = {
      target_url: `${URL_PREFIX}${String(Date.now())}`,
      category: 'abuse',
      explanation: 'Обидно име в класирането.',
      notifier_name: null,
      notifier_email: 'notifier@example.test',
      good_faith: true,
      ...overrides,
    };
    const result = await client.query<{ id: string }>(
      `INSERT INTO content_notices
         (target_url, category, explanation, notifier_name, notifier_email, good_faith)
       VALUES ($1, $2::content_notice_category, $3, $4, $5, $6)
       RETURNING id`,
      [
        row.target_url,
        row.category,
        row.explanation,
        row.notifier_name,
        row.notifier_email,
        row.good_faith,
      ],
    );
    return result.rows[0]?.id ?? '';
  }

  async function decide(id: string, status = 'dismissed', reason = 'not_illegal'): Promise<void> {
    await client.query(
      `UPDATE content_notices
          SET status = $2::content_notice_status, decided_at = now(), decided_by = $3,
              decision_reason = $4
        WHERE id = $1::uuid`,
      [id, status, ADMIN, reason],
    );
  }

  describe('what a notice may be', () => {
    it('accepts a notice with a site path, an optional contact and good faith', async () => {
      expect(await notice()).not.toBe('');
      expect(await notice({ notifier_email: null })).not.toBe('');
    });

    it('refuses a URL the admin queue could be tricked into rendering as a script', async () => {
      await expect(notice({ target_url: 'javascript:alert(1)' })).rejects.toThrow(
        /content_notices_target_url_shape/,
      );
      await expect(notice({ target_url: `${URL_PREFIX}with space` })).rejects.toThrow(
        /content_notices_target_url_shape/,
      );
    });

    it("refuses a site path that smuggles in somebody else's host", async () => {
      for (const smuggled of [
        // An embedded URL: no POPS path has one, and a mail client links it.
        `${URL_PREFIX}https://evil.example/login`,
        // A browser reads a backslash as a slash: `/\host` is `//host`.
        `/\\evil.example/login`,
        `${URL_PREFIX}a\\b`,
        // Protocol-relative: somebody else's host outright.
        '//evil.example/login',
      ]) {
        await expect(notice({ target_url: smuggled }), smuggled).rejects.toThrow(
          /content_notices_target_url_shape/,
        );
      }
    });

    it('refuses a notice without its statement of good faith', async () => {
      await expect(notice({ good_faith: false })).rejects.toThrow(/content_notices_good_faith/);
    });

    it('refuses an empty explanation', async () => {
      await expect(notice({ explanation: '   ' })).rejects.toThrow(
        /content_notices_explanation_len/,
      );
    });

    it('refuses a half-recorded decision', async () => {
      const id = await notice();
      await expect(
        client.query(`UPDATE content_notices SET status = 'actioned' WHERE id = $1::uuid`, [id]),
      ).rejects.toThrow(/content_notices_decision_complete/);
    });
  });

  describe('the guard', () => {
    it('freezes what was reported, even while pending', async () => {
      const id = await notice();
      await expect(
        client.query(`UPDATE content_notices SET explanation = 'друго' WHERE id = $1::uuid`, [id]),
      ).rejects.toThrow(/cannot be edited/);
    });

    it('makes a decision final', async () => {
      const id = await notice();
      await decide(id, 'actioned', 'illegal_content');
      await expect(decide(id, 'dismissed', 'not_illegal')).rejects.toThrow(/final/);
    });

    it('lets the notifier contact be erased, and never rewritten', async () => {
      const id = await notice({ notifier_name: 'Иван' });
      await decide(id);
      await expect(
        client.query(
          `UPDATE content_notices SET notifier_email = 'other@example.test' WHERE id = $1::uuid`,
          [id],
        ),
      ).rejects.toThrow(/may only be erased/);
      await client.query(
        `UPDATE content_notices SET notifier_email = NULL, notifier_name = NULL WHERE id = $1::uuid`,
        [id],
      );
      const after = await client.query(
        `SELECT notifier_email, status FROM content_notices WHERE id = $1::uuid`,
        [id],
      );
      expect(after.rows[0]).toMatchObject({ notifier_email: null, status: 'dismissed' });
    });

    it('refuses to delete a notice', async () => {
      const id = await notice();
      await expect(
        client.query(`DELETE FROM content_notices WHERE id = $1::uuid`, [id]),
      ).rejects.toThrow(/never deleted/);
    });
  });

  describe('retention', () => {
    it('erases contacts only on notices decided longer ago than the retention', async () => {
      const old = await client.query<{ id: string }>(
        `INSERT INTO content_notices
           (target_url, category, explanation, notifier_email, good_faith, status,
            decided_at, decided_by, decision_reason, created_at)
         VALUES ($1, 'spam', 'Реклама.', 'old@example.test', true, 'dismissed',
                 now() - interval '200 days', $2, 'not_illegal', now() - interval '201 days')
         RETURNING id`,
        [`${URL_PREFIX}old`, ADMIN],
      );
      const oldId = old.rows[0]?.id ?? '';
      const recent = await notice();
      await decide(recent);
      const pending = await notice();

      expect(await eraseExpiredNotifierContacts(db, 180)).toBeGreaterThanOrEqual(1);

      const rows = await client.query<{ id: string; notifier_email: string | null }>(
        `SELECT id, notifier_email FROM content_notices WHERE id = ANY($1::uuid[])`,
        [[oldId, recent, pending]],
      );
      const email = new Map(rows.rows.map((r) => [r.id, r.notifier_email]));
      expect(email.get(oldId)).toBeNull();
      expect(email.get(recent)).toBe('notifier@example.test');
      // Undecided: the notifier is still owed an answer.
      expect(email.get(pending)).toBe('notifier@example.test');
    });
  });

  describe('notice mail', () => {
    it('resolves the reply address, and nobody when none was left', async () => {
      const withEmail = await notice();
      const target = await noticeMailTarget(db, withEmail);
      expect(target).toMatchObject({
        email: 'notifier@example.test',
        status: 'pending',
        category: 'abuse',
      });
      expect(target?.receivedOn).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
      // The reply address is whatever an anonymous form was given, so nothing
      // the notifier WROTE is read for the mail — above all not the URL.
      expect(target).not.toHaveProperty('targetUrl');
      expect(JSON.stringify(target)).not.toContain(URL_PREFIX);

      const anonymous = await notice({ notifier_email: null });
      expect(await noticeMailTarget(db, anonymous)).toBeNull();
    });

    it('lets exactly one receipt and one outcome through', async () => {
      const id = await notice();
      expect(await claimModerationNotification(db, { kind: 'notice_received', noticeId: id })).toBe(
        true,
      );
      expect(await claimModerationNotification(db, { kind: 'notice_received', noticeId: id })).toBe(
        false,
      );
      // A different fact about the same notice is a different message.
      expect(await claimModerationNotification(db, { kind: 'notice_decided', noticeId: id })).toBe(
        true,
      );
    });
  });

  describe('statement of reasons', () => {
    let photoSeq = 0;
    async function photoDecision(
      decision: 'rejected' | 'removed' | 'approved',
      reason: string | null,
    ) {
      photoSeq += 1;
      // A taken-down photo is stored as 'rejected' (0032); only the log says 'removed'.
      const status = decision === 'removed' ? 'rejected' : decision;
      const photo = await client.query<{ id: string }>(
        `INSERT INTO facility_photos (facility_id, storage_path, status, uploaded_by)
         VALUES ($1::uuid, $2, $3::photo_status, $4) RETURNING id`,
        [
          facilityId,
          `photos/e2e-notice-${String(Date.now())}-${String(photoSeq)}.webp`,
          status,
          UPLOADER,
        ],
      );
      const photoId = photo.rows[0]?.id ?? '';
      const logged = await client.query<{ id: string }>(
        `INSERT INTO moderation_decisions
           (actor_id, target_type, target_id, facility_id, decision, reason, queued_at)
         VALUES ($1, 'photo', $2::uuid, $3::uuid, $4::moderation_decision, $5,
                 now() - interval '1 hour')
         RETURNING id`,
        [ADMIN, photoId, facilityId, decision, reason],
      );
      return Number(logged.rows[0]?.id);
    }

    it("still takes the previous build's refusal, which names no reason", async () => {
      // Expand/contract (0034 header): the build before 0034 never writes
      // `reason`, and it runs against this schema in the migrate → up window
      // and after a rollback_to. Its rejections and takedowns must land, or a
      // reported photo stays up. The application refuses a reasonless refusal
      // meanwhile (apps/web/tests/moderation.test.ts); when the contract
      // migration adds the CHECK, this becomes a refusal test again. An
      // explicit NULL is what the old build's omitted column gives: no default.
      const rejected = await photoDecision('rejected', null);
      const removed = await photoDecision('removed', null);
      expect(rejected).toBeGreaterThan(0);
      // Such a row still resolves for the mail path, with no reason to state.
      expect(await decisionMailTarget(db, removed)).toMatchObject({
        kind: 'photo_removed',
        reason: null,
      });
    });

    it('refuses a reason outside the slug shape', async () => {
      await expect(photoDecision('rejected', 'Грозна снимка')).rejects.toThrow(
        /moderation_decisions_reason_format/,
      );
    });

    it('finds the uploader of a rejected photo, once, and nobody after erasure', async () => {
      const decisionId = await photoDecision('rejected', 'identifiable_person');

      const target = await decisionMailTarget(db, decisionId);
      expect(target).toMatchObject({
        kind: 'photo_rejected',
        email: 'uploader@example.test',
        reason: 'identifiable_person',
      });

      expect(await claimModerationNotification(db, { kind: 'decision', decisionId })).toBe(true);
      expect(await claimModerationNotification(db, { kind: 'decision', decisionId })).toBe(false);

      // Erasure sets uploaded_by NULL: the job that runs after it tells nobody.
      await client.query(`DELETE FROM users WHERE id = $1`, [UPLOADER]);
      expect(await decisionMailTarget(db, decisionId)).toBeNull();
    });

    it('names a takedown as one, with its reason', async () => {
      const decisionId = await photoDecision('removed', 'not_uploaders_rights');
      expect(await decisionMailTarget(db, decisionId)).toMatchObject({
        kind: 'photo_removed',
        email: 'uploader@example.test',
        reason: 'not_uploaders_rights',
      });
    });

    it('tells nobody about an approval — it restricts nothing', async () => {
      const decisionId = await photoDecision('approved', null);
      expect(await decisionMailTarget(db, decisionId)).toBeNull();
    });
  });
});

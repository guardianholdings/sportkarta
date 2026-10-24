import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupClubFixtures,
  failure,
  makeClub,
  makeMember,
  makePlan,
  purgeClub,
  sellMembership,
  type ClubFixture,
} from './clubs/test-fixtures.js';

/**
 * The club ledgers (0039, 0041, 0044) — what can never be edited, and the one
 * door each of them leaves open.
 *
 *   club_audit, club_monthly_activity  append-only; deletable only while
 *                                      purging THAT club.
 *   club_payments                      append-only; the one UPDATE is the
 *                                      erasure's member_id → NULL.
 *   club_charges                       voided (once), never deleted.
 *   club_payments_within_charge        a charge's running total stays within
 *                                      [0, amount]; a void charge takes
 *                                      refunds only.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('club ledgers (requires running database)', () => {
  let client: pg.Client;
  let club: ClubFixture;
  let memberId: string;
  let chargeId: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await cleanupClubFixtures(client);
    await client.end();
  });

  beforeEach(async () => {
    await cleanupClubFixtures(client);
    club = await makeClub(client, 'ledgers');
    memberId = await makeMember(client, club.clubId, 'Петър');
    const planId = await makePlan(client, club.clubId, { priceCents: 6000 });
    ({ chargeId } = await sellMembership(client, club.clubId, memberId, planId));
  });

  async function pay(amount: number, kind = amount < 0 ? 'refund' : 'payment'): Promise<void> {
    await client.query(
      `INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method, received_on, recorded_by)
       VALUES ($1, $2, $3, $4, $5, 'cash', current_date, $6)`,
      [club.clubId, chargeId, memberId, kind, amount, club.ownerId],
    );
  }

  async function status(): Promise<{ status: string; paid: number; due: number }> {
    const row = await client.query<{ status: string; paid_cents: number; due_cents: number }>(
      `SELECT status, paid_cents, due_cents FROM club_charge_balances WHERE charge_id = $1`,
      [chargeId],
    );
    const r = row.rows[0];
    return { status: r?.status ?? '', paid: Number(r?.paid_cents), due: Number(r?.due_cents) };
  }

  describe('club_payments', () => {
    it('derives open → partial → paid from the rows, never from a column', async () => {
      expect(await status()).toEqual({ status: 'open', paid: 0, due: 6000 });
      await pay(2000);
      expect(await status()).toEqual({ status: 'partial', paid: 2000, due: 4000 });
      await pay(4000);
      expect(await status()).toEqual({ status: 'paid', paid: 6000, due: 0 });
    });

    it('refuses an overpayment and a refund below zero, as a named constraint', async () => {
      await pay(5000);
      const over = await failure(pay(1001));
      expect(over.code).toBe('23514');
      expect(over.constraint).toBe('club_payments_within_charge');
      const under = await failure(pay(-5001));
      expect(under.constraint).toBe('club_payments_within_charge');
      await pay(-5000);
      expect(await status()).toEqual({ status: 'open', paid: 0, due: 6000 });
    });

    it('cannot be edited or deleted — a refund is a new row', async () => {
      await pay(1000);
      const edit = await failure(
        client.query(`UPDATE club_payments SET amount_cents = 1 WHERE charge_id = $1`, [chargeId]),
      );
      expect(edit.message).toMatch(/append-only/);
      const erase = await failure(
        client.query(`DELETE FROM club_payments WHERE charge_id = $1`, [chargeId]),
      );
      expect(erase.message).toMatch(/append-only/);
      const truncate = await failure(client.query(`TRUNCATE club_payments`));
      expect(truncate.message).toMatch(/append-only/);
    });

    it('admits exactly one update: member_id cleared by the erasure', async () => {
      await pay(1000);
      const reassign = await failure(
        client.query(
          `UPDATE club_payments SET member_id = gen_random_uuid() WHERE charge_id = $1`,
          [chargeId],
        ),
      );
      expect(reassign.message).toMatch(/append-only/);
      await client.query(`UPDATE club_payments SET member_id = NULL WHERE charge_id = $1`, [
        chargeId,
      ]);
    });

    it('pins the sign to the kind', async () => {
      // A balance first, so the BEFORE INSERT total check (which runs ahead of
      // CHECK constraints) passes and the sign CHECK is what refuses.
      await pay(1000);
      const negativePayment = await failure(pay(-10, 'payment'));
      expect(negativePayment.constraint).toBe('club_payments_sign_matches_kind');
      const positiveRefund = await failure(pay(10, 'refund'));
      expect(positiveRefund.constraint).toBe('club_payments_sign_matches_kind');
    });
  });

  describe('club_charges', () => {
    it('is voided once and then accepts refunds only', async () => {
      await pay(1000);
      await client.query(`UPDATE club_charges SET voided_at = now() WHERE id = $1`, [chargeId]);
      expect((await status()).status).toBe('void');
      const unvoid = await failure(
        client.query(`UPDATE club_charges SET voided_at = NULL WHERE id = $1`, [chargeId]),
      );
      expect(unvoid.message).toMatch(/void is final/);
      const payVoid = await failure(pay(500));
      expect(payVoid.constraint).toBe('club_payments_charge_not_void');
      await pay(-1000);
    });

    it('never changes its facts and is never deleted', async () => {
      const relabel = await failure(
        client.query(`UPDATE club_charges SET amount_cents = 1 WHERE id = $1`, [chargeId]),
      );
      expect(relabel.message).toMatch(/only voiding and anonymisation/);
      const erase = await failure(
        client.query(`DELETE FROM club_charges WHERE id = $1`, [chargeId]),
      );
      expect(erase.message).toMatch(/never deleted/);
    });
  });

  describe('club_audit and the purge', () => {
    async function audit(clubId: string): Promise<void> {
      await client.query(
        `INSERT INTO club_audit (club_id, actor_id, actor_kind, action)
         VALUES ($1, $2, 'staff', 'settings_changed')`,
        [clubId, club.ownerId],
      );
    }

    it('is append-only', async () => {
      await audit(club.clubId);
      const edit = await failure(
        client.query(`UPDATE club_audit SET action = 'plan_saved' WHERE club_id = $1`, [
          club.clubId,
        ]),
      );
      expect(edit.message).toMatch(/append-only/);
      const erase = await failure(
        client.query(`DELETE FROM club_audit WHERE club_id = $1`, [club.clubId]),
      );
      expect(erase.message).toMatch(/append-only/);
    });

    it('refuses to delete a club that has books, unless purging that very club', async () => {
      await audit(club.clubId);
      await pay(1000);
      const plain = await failure(client.query(`DELETE FROM clubs WHERE id = $1`, [club.clubId]));
      expect(plain.message).toMatch(/append-only|never deleted/);

      // The GUC names ANOTHER club: still refused.
      const other = await makeClub(client, 'ledgers-other');
      await client.query('BEGIN');
      await client.query(`SELECT set_config('pops.purging_club', $1, true)`, [other.clubId]);
      const wrong = await failure(client.query(`DELETE FROM clubs WHERE id = $1`, [club.clubId]));
      await client.query('ROLLBACK');
      expect(wrong.message).toMatch(/append-only|never deleted/);

      await purgeClub(client, club.clubId);
      const left = await client.query(
        `SELECT (SELECT count(*) FROM club_payments WHERE club_id = $1)
              + (SELECT count(*) FROM club_audit WHERE club_id = $1)
              + (SELECT count(*) FROM club_members WHERE club_id = $1) AS n`,
        [club.clubId],
      );
      expect(Number(left.rows[0]?.n)).toBe(0);
    });

    it('scopes the purge GUC to the transaction', async () => {
      await audit(club.clubId);
      await client.query('BEGIN');
      await client.query(`SELECT set_config('pops.purging_club', $1, true)`, [club.clubId]);
      await client.query('COMMIT');
      const after = await failure(
        client.query(`DELETE FROM club_audit WHERE club_id = $1`, [club.clubId]),
      );
      expect(after.message).toMatch(/append-only/);
    });
  });

  describe('club_monthly_activity', () => {
    it('is written once per month and never edited', async () => {
      await client.query(
        `INSERT INTO club_monthly_activity (club_id, month, members_with_membership, members_with_visits,
                                            members_active, checkins, bookings, revenue_cents)
         VALUES ($1, date_trunc('month', now())::date, 3, 2, 4, 10, 5, 12000)`,
        [club.clubId],
      );
      const notUnion = await failure(
        client.query(
          `INSERT INTO club_monthly_activity (club_id, month, members_with_membership, members_with_visits,
                                              members_active, checkins, bookings, revenue_cents)
           VALUES ($1, (date_trunc('month', now()) - interval '1 month')::date, 3, 2, 6, 0, 0, 0)`,
          [club.clubId],
        ),
      );
      expect(notUnion.constraint).toBe('club_monthly_activity_active_is_union');
      const edit = await failure(
        client.query(`UPDATE club_monthly_activity SET checkins = 0 WHERE club_id = $1`, [
          club.clubId,
        ]),
      );
      expect(edit.message).toMatch(/append-only/);
    });
  });
});

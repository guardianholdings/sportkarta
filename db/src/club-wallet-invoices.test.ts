import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupClubFixtures,
  failure,
  makeClub,
  makeMember,
  type ClubFixture,
} from './clubs/test-fixtures.js';

/**
 * The wallet and invoices (0050): the books hold by construction.
 *
 * What must hold:
 *   - credit is derived from the 0041 books; every row the club writes keeps
 *     it at zero or above, is the charge's own client's, never pays credit
 *     with credit, and gives back on a charge no more than was spent there;
 *     a refund the provider reports is recorded whatever the balance;
 *   - a top-up is never owed, never voided with money on it, and names its
 *     client;
 *   - an invoice takes the number just drawn, its lines are written with it
 *     and add up to it at commit, it is never changed, one live invoice per
 *     charge, and a credit note corrects it as issued, by no more than is
 *     left; a number drawn without its document is refused; every buyer has
 *     an address;
 *   - credit is invoiced when it is LOADED: a top-up is invoiced, a charge
 *     credit was spent on is not, and credit never pays a charge with a live
 *     invoice.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('club wallet and invoices (requires running database)', () => {
  let client: pg.Client;
  let club: ClubFixture;
  let memberId: string;

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
    club = await makeClub(client, 'wallet');
    memberId = await makeMember(client, club.clubId, 'Мария');
  });

  const charge = async (kind: string, amount: number, member: string | null = memberId) =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO club_charges (club_id, member_id, kind, label, amount_cents, issued_on, due_on)
         VALUES ($1, $2, $3, 'Тест', $4, current_date, current_date) RETURNING id`,
        [club.clubId, member, kind, amount],
      )
    ).rows[0]?.id ?? '';

  const pay = (
    chargeId: string,
    amount: number,
    method: string,
    options: { member?: string | null; provider?: string; ref?: string } = {},
  ) =>
    client.query(
      `INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method,
                                  provider, provider_ref, received_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, current_date)`,
      [
        club.clubId,
        chargeId,
        options.member === undefined ? memberId : options.member,
        amount < 0 ? 'refund' : 'payment',
        amount,
        method,
        options.provider ?? 'manual',
        options.ref ?? null,
      ],
    );

  const balance = async () =>
    Number(
      (
        await client.query<{ balance: string }>(
          `SELECT coalesce(sum(balance_cents), 0) AS balance FROM club_wallet_balances
            WHERE club_id = $1 AND member_id = $2`,
          [club.clubId, memberId],
        )
      ).rows[0]?.balance,
    );

  it('keeps credit at zero or above, its own client’s, and never circular', async () => {
    const topUp = await charge('wallet', 5000);
    await pay(topUp, 5000, 'cash');
    expect(await balance()).toBe(5000);
    // A top-up is never owed, even when part of it is paid back.
    await pay(topUp, -1000, 'cash');
    const owed = await client.query<{ due_cents: number; status: string }>(
      `SELECT due_cents, status FROM club_charge_balances WHERE charge_id = $1`,
      [topUp],
    );
    expect(owed.rows[0]).toEqual({ due_cents: 0, status: 'paid' });
    expect(await balance()).toBe(4000);

    const bar = await charge('product', 3000);
    await pay(bar, 3000, 'wallet');
    expect(await balance()).toBe(1000);
    // More than is left: refused.
    const drink = await charge('product', 1500);
    expect((await failure(pay(drink, 1500, 'wallet'))).constraint).toBe(
      'club_payments_wallet_balance',
    );
    // Credit is not paid with credit, and is the charge's own client's.
    expect((await failure(pay(topUp, 500, 'wallet'))).constraint).toBe(
      'club_payments_wallet_not_circular',
    );
    const someoneElse = await makeMember(client, club.clubId, 'Иван');
    const theirs = await charge('product', 200, someoneElse);
    expect((await failure(pay(theirs, 200, 'wallet'))).constraint).toBe(
      'club_payments_wallet_member',
    );
    // Given back on a charge no more than was spent there — cash paid for a
    // charge never turns into credit.
    await pay(drink, 1500, 'cash');
    expect((await failure(pay(drink, -500, 'wallet'))).constraint).toBe(
      'club_payments_wallet_refund',
    );
    await pay(bar, -3000, 'wallet');
    expect(await balance()).toBe(4000);
    // With money on it, a top-up is refunded, never voided.
    expect(
      (
        await failure(
          client.query(`UPDATE club_charges SET voided_at = now() WHERE id = $1`, [topUp]),
        )
      ).constraint,
    ).toBe('club_charges_wallet_void');
    // A top-up names its client.
    expect((await failure(charge('wallet', 100, null))).constraint).toBe(
      'club_charges_wallet_client',
    );
  });

  it('records a refund the provider reports, whatever the balance — then spending stops', async () => {
    const topUp = await charge('wallet', 5000);
    await pay(topUp, 5000, 'card_online', { provider: 'fake', ref: 'fake_pi_wallet_1' });
    const bar = await charge('product', 3000);
    await pay(bar, 3000, 'wallet');
    // Refunded at the provider in full after 30 were spent: a fact.
    await pay(topUp, -5000, 'card_online', { provider: 'fake', ref: 'fake_re_wallet_1' });
    expect(await balance()).toBe(-3000);
    const next = await charge('product', 100);
    expect((await failure(pay(next, 100, 'wallet'))).constraint).toBe(
      'club_payments_wallet_balance',
    );
    // A top-up of what is owed is always taken.
    const settle = await charge('wallet', 3000);
    await pay(settle, 3000, 'cash');
    expect(await balance()).toBe(0);
  });

  const supplier = ['Клуб ЕООД', '123456789', null, 'София, ул. Тест 1', null] as const;

  /** An invoice for `chargeId`, written as the application writes one. */
  async function invoice(
    chargeId: string,
    options: {
      lines?: number[];
      total?: number;
      commit?: boolean;
      issuedOn?: string;
      address?: string | null;
      /** A VAT-registered supplier, its lines at 0 % (no basis given). */
      zeroRated?: boolean;
    } = {},
  ): Promise<string> {
    const lines = options.lines ?? [1200];
    const total = options.total ?? lines.reduce((sum, l) => sum + l, 0);
    await client.query('BEGIN');
    const number = Number(
      (
        await client.query<{ last_value: string }>(
          `INSERT INTO club_number_sequences (club_id, kind, last_value) VALUES ($1, 'invoice', 1)
           ON CONFLICT (club_id, kind) DO UPDATE SET last_value = club_number_sequences.last_value + 1
           RETURNING last_value`,
          [club.clubId],
        )
      ).rows[0]?.last_value,
    );
    const id =
      (
        await client.query<{ id: string }>(
          `INSERT INTO club_invoices (club_id, kind, number, issued_on, tax_event_on, charge_id,
                                      member_id, supplier_name, supplier_eik, supplier_vat_number,
                                      supplier_address, supplier_iban, buyer_kind, buyer_name,
                                      buyer_address, payment_method, base_cents, vat_cents,
                                      total_cents, issued_by)
           VALUES ($1, 'invoice', $2, coalesce($3::date, current_date),
                   coalesce($3::date, current_date), $4, $5, $6, $7, $8, $9, $10, 'person',
                   'Мария', $13, 'cash', $11, 0, $11, $12)
           RETURNING id`,
          [
            club.clubId,
            number,
            options.issuedOn ?? null,
            chargeId,
            memberId,
            supplier[0],
            supplier[1],
            options.zeroRated ? 'BG123456789' : supplier[2],
            supplier[3],
            supplier[4],
            total,
            club.ownerId,
            options.address === undefined ? 'София, ул. Клиент 2' : options.address,
          ],
        )
      ).rows[0]?.id ?? '';
    for (const [index, amount] of lines.entries()) {
      await client.query(
        `INSERT INTO club_invoice_lines (club_id, invoice_id, line_no, description, quantity,
                                         unit_price_cents, vat_rate_bp, base_cents, vat_cents,
                                         total_cents)
         VALUES ($1, $2, $3, 'Абонамент', 1, $4, $5, $4, 0, $4)`,
        [club.clubId, id, index + 1, amount, options.zeroRated ? 0 : null],
      );
    }
    if (options.commit === false) return id;
    await client.query('COMMIT');
    return id;
  }

  it('keeps an invoice a document: numbered, whole, and never changed', async () => {
    const membership = await charge('membership', 1200);
    const id = await invoice(membership);
    // One live invoice per charge.
    expect((await failure(invoice(membership))).constraint).toBe('club_invoices_one_per_charge');
    await client.query('ROLLBACK');
    // Lines are written with their invoice, never later.
    expect(
      (
        await failure(
          client.query(
            `INSERT INTO club_invoice_lines (club_id, invoice_id, line_no, description, quantity,
                                             unit_price_cents, base_cents, vat_cents, total_cents)
             VALUES ($1, $2, 2, 'Още', 1, 100, 100, 0, 100)`,
            [club.clubId, id],
          ),
        )
      ).constraint,
    ).toBe('club_invoice_lines_with_invoice');
    expect(
      (
        await failure(
          client.query(`UPDATE club_invoices SET buyer_name = 'Друг' WHERE id = $1`, [id]),
        )
      ).constraint,
    ).toBe('club_invoices_fact');
    expect(
      (await failure(client.query(`DELETE FROM club_invoices WHERE id = $1`, [id]))).message,
    ).toMatch(/never deleted/);
    // Lines that do not add up to the totals are refused at commit.
    const other = await charge('membership', 1200);
    await invoice(other, { lines: [1000], total: 1200, commit: false });
    expect((await failure(client.query('COMMIT'))).constraint).toBe('club_invoices_lines_add_up');
    // Every buyer has an address, a person too.
    const third = await charge('membership', 1200);
    expect((await failure(invoice(third, { address: null }))).code).toBe('23502');
    await client.query('ROLLBACK');
    expect((await failure(invoice(third, { address: '  ' }))).constraint).toBe(
      'club_invoices_buyer_sane',
    );
    await client.query('ROLLBACK');
    // A VAT-registered supplier's 0 % line states its basis (checked at commit).
    await invoice(third, { zeroRated: true, commit: false });
    expect((await failure(client.query('COMMIT'))).constraint).toBe(
      'club_invoices_zero_basis_required',
    );
    // A number drawn without its document is refused at commit.
    expect(
      (
        await failure(
          client.query(
            `UPDATE club_number_sequences SET last_value = last_value + 1
              WHERE club_id = $1 AND kind = 'invoice'`,
            [club.clubId],
          ),
        )
      ).constraint,
    ).toBe('club_number_sequences_used');
    // Never dated before the previous number.
    expect((await failure(invoice(other, { issuedOn: '2020-01-01' }))).constraint).toBe(
      'club_invoices_chronology',
    );
    await client.query('ROLLBACK');
  });

  it('corrects an invoice by a credit note, as issued, by no more than is left', async () => {
    const membership = await charge('membership', 1200);
    const original = await invoice(membership);
    const credit = async (
      total: number,
      buyer = 'Мария',
      forMember = memberId,
    ): Promise<string> => {
      await client.query('BEGIN');
      const number = Number(
        (
          await client.query<{ last_value: string }>(
            `UPDATE club_number_sequences SET last_value = last_value + 1
              WHERE club_id = $1 AND kind = 'invoice' RETURNING last_value`,
            [club.clubId],
          )
        ).rows[0]?.last_value,
      );
      const id =
        (
          await client.query<{ id: string }>(
            `INSERT INTO club_invoices (club_id, kind, number, issued_on, tax_event_on,
                                        corrects_id, reason, charge_id, member_id, supplier_name,
                                        supplier_eik, supplier_vat_number, supplier_address,
                                        supplier_iban, buyer_kind, buyer_name, buyer_address,
                                        payment_method, base_cents, vat_cents, total_cents,
                                        issued_by)
             VALUES ($1, 'credit_note', $2, current_date, current_date, $3, 'Анулиране', $4, $5,
                     $6, $7, $8, $9, $10, 'person', $11, 'София, ул. Клиент 2', 'cash', $12, 0,
                     $12, $13)
             RETURNING id`,
            [
              club.clubId,
              number,
              original,
              membership,
              forMember,
              ...supplier,
              buyer,
              total,
              club.ownerId,
            ],
          )
        ).rows[0]?.id ?? '';
      await client.query(
        `INSERT INTO club_invoice_lines (club_id, invoice_id, line_no, description, quantity,
                                         unit_price_cents, base_cents, vat_cents, total_cents)
         VALUES ($1, $2, 1, 'Абонамент', 1, $3, $3, 0, $3)`,
        [club.clubId, id, total],
      );
      await client.query('COMMIT');
      return id;
    };
    // The parties as issued, filed under the invoice's own client.
    expect((await failure(credit(1200, 'Друг'))).constraint).toBe(
      'club_invoices_credit_within_invoice',
    );
    await client.query('ROLLBACK');
    const someoneElse = await makeMember(client, club.clubId, 'Друга');
    expect((await failure(credit(1200, 'Мария', someoneElse))).constraint).toBe(
      'club_invoices_credit_within_invoice',
    );
    await client.query('ROLLBACK');
    await credit(1200);
    // Nothing is left of it.
    expect((await failure(credit(1))).constraint).toBe('club_invoices_credit_within_invoice');
    await client.query('ROLLBACK');
    // Wholly credited, the charge may have a new invoice.
    await invoice(membership);
  });

  it('invoices credit when it is loaded, and never again where it is spent', async () => {
    // The top-up is invoiced like any charge.
    const topUp = await charge('wallet', 5000);
    await pay(topUp, 5000, 'cash');
    await invoice(topUp, { lines: [5000] });
    // A charge credit was spent on is not invoiced again…
    const bar = await charge('product', 1200);
    await pay(bar, 1200, 'wallet');
    expect((await failure(invoice(bar))).constraint).toBe('club_invoices_wallet_spent');
    await client.query('ROLLBACK');
    // Spent credit never leaves as money: it goes back as credit…
    expect((await failure(pay(bar, -1200, 'cash'))).constraint).toBe(
      'club_payments_wallet_cash_back',
    );
    // …and then the charge may be paid otherwise, and invoiced.
    await pay(bar, -1200, 'wallet');
    await pay(bar, 1200, 'cash');
    await invoice(bar);
    // Credit never pays a charge with a live invoice; other money still does.
    const membership = await charge('membership', 1200);
    await invoice(membership);
    expect((await failure(pay(membership, 1200, 'wallet'))).constraint).toBe(
      'club_payments_wallet_invoiced',
    );
    await pay(membership, 1200, 'cash');
  });

  it('keeps an invoice when its client is erased', async () => {
    const membership = await charge('membership', 1200);
    const id = await invoice(membership);
    await client.query(`DELETE FROM club_members WHERE id = $1`, [memberId]);
    const kept = await client.query<{ member_id: string | null; buyer_name: string }>(
      `SELECT member_id, buyer_name FROM club_invoices WHERE id = $1`,
      [id],
    );
    expect(kept.rows[0]).toEqual({ member_id: null, buyer_name: 'Мария' });
  });
});

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupClubFixtures,
  failure,
  makeClub,
  makeMember,
  makePlan,
  sellMembership,
  type ClubFixture,
} from './clubs/test-fixtures.js';

/**
 * The shop and offers (0049): the ledgers hold by construction.
 *
 * What must hold:
 *   - sale numbers are gapless per club — a rolled-back sale gives its number
 *     back — and a counter only ever moves up by one;
 *   - a sale is a fact (reversed once, never edited or deleted); its lines and
 *     the stock ledger never change; a movement's sign follows its kind; stock
 *     on hand is the ledger's sum and may go below zero;
 *   - an offer's use survives the erasure of the client and of the
 *     membership it discounted; one use per sale or membership;
 *   - a membership use names a membership of the same client, a sale use
 *     none; a product or an offer with history is never deleted;
 *   - nothing reaches into another club (composite keys);
 *   - an online purchase's offer is fixed once the checkout exists.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('club shop and offers (requires running database)', () => {
  let client: pg.Client;
  let club: ClubFixture;
  let memberId: string;
  let productId: string;

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
    club = await makeClub(client, 'shop');
    memberId = await makeMember(client, club.clubId, 'Мария');
    productId =
      (
        await client.query<{ id: string }>(
          `INSERT INTO club_products (club_id, name, category, price_cents)
           VALUES ($1, 'Вода', 'drink', 150) RETURNING id`,
          [club.clubId],
        )
      ).rows[0]?.id ?? '';
  });

  const nextNumber = async (c: pg.Client = client) =>
    Number(
      (
        await c.query<{ last_value: string }>(
          `INSERT INTO club_number_sequences (club_id, kind, last_value) VALUES ($1, 'sale', 1)
           ON CONFLICT (club_id, kind) DO UPDATE SET last_value = club_number_sequences.last_value + 1
           RETURNING last_value`,
          [club.clubId],
        )
      ).rows[0]?.last_value,
    );

  async function sale(number: number, total = 300): Promise<string> {
    const charge =
      total > 0
        ? ((
            await client.query<{ id: string }>(
              `INSERT INTO club_charges (club_id, kind, label, amount_cents, issued_on, due_on)
               VALUES ($1, 'product', 'Продажба', $2, current_date, current_date) RETURNING id`,
              [club.clubId, total],
            )
          ).rows[0]?.id ?? null)
        : null;
    const created = await client.query<{ id: string }>(
      `INSERT INTO club_sales (club_id, number, charge_id, subtotal_cents, total_cents, sold_by)
       VALUES ($1, $2, $3, $4, $4, $5) RETURNING id`,
      [club.clubId, number, charge, total, club.ownerId],
    );
    const saleId = created.rows[0]?.id ?? '';
    await client.query(
      `INSERT INTO club_sale_lines (club_id, sale_id, line_no, product_id, name, unit_price_cents,
                                    quantity, total_cents, vat_rate_bp)
       VALUES ($1, $2, 1, $3, 'Вода', 150, 2, 300, 2000)`,
      [club.clubId, saleId, productId],
    );
    return saleId;
  }

  it('numbers sales gaplessly, and a rolled-back sale gives its number back', async () => {
    expect(await nextNumber()).toBe(1);
    await client.query('BEGIN');
    expect(await nextNumber()).toBe(2);
    await client.query('ROLLBACK');
    expect(await nextNumber()).toBe(2);
    const skip = await failure(
      client.query(
        `UPDATE club_number_sequences SET last_value = last_value + 5 WHERE club_id = $1`,
        [club.clubId],
      ),
    );
    expect(skip.message).toMatch(/only moves up by one/);
    expect(
      (
        await failure(
          client.query(`DELETE FROM club_number_sequences WHERE club_id = $1`, [club.clubId]),
        )
      ).message,
    ).toMatch(/never removed/);
    // A sale takes the number its transaction just drew — never another.
    expect((await failure(sale(1))).constraint).toBe('club_sales_number_drawn');
    await sale(2);
    expect((await failure(sale(2))).constraint).toBe('club_sales_number_unique');
  });

  it('keeps a sale a fact: reversed once, lines never changed', async () => {
    const saleId = await sale(await nextNumber());
    expect(
      (await failure(client.query(`UPDATE club_sales SET total_cents = 1 WHERE id = $1`, [saleId])))
        .constraint,
    ).toBe('club_sales_fact');
    await client.query(
      `UPDATE club_sales SET reversed_at = now(), reversed_by = $2 WHERE id = $1`,
      [saleId, club.ownerId],
    );
    expect(
      (
        await failure(
          client.query(
            `UPDATE club_sales SET reversed_at = now() - interval '1 day' WHERE id = $1`,
            [saleId],
          ),
        )
      ).constraint,
    ).toBe('club_sales_fact');
    expect(
      (
        await failure(
          client.query(`UPDATE club_sale_lines SET quantity = 9 WHERE sale_id = $1`, [saleId]),
        )
      ).message,
    ).toMatch(/never changes/);
    expect(
      (await failure(client.query(`DELETE FROM club_sales WHERE id = $1`, [saleId]))).message,
    ).toMatch(/never deleted/);
    // A free sale has no charge; a priced one must have one.
    await sale(await nextNumber(), 0);
    const priced = await failure(
      client.query(
        `INSERT INTO club_sales (club_id, number, subtotal_cents, total_cents, sold_by)
         VALUES ($1, $2, 100, 100, $3)`,
        [club.clubId, await nextNumber(), club.ownerId],
      ),
    );
    expect(priced.constraint).toBe('club_sales_charge_iff_total');
  });

  it('counts stock from an append-only ledger whose signs follow the kind', async () => {
    const move = (kind: string, quantity: number, saleId: string | null = null) =>
      client.query(
        `INSERT INTO club_stock_movements (club_id, product_id, kind, quantity, sale_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [club.clubId, productId, kind, quantity, saleId],
      );
    await move('receive', 10);
    const saleId = await sale(await nextNumber());
    await move('sale', -12, saleId);
    const onHand = async () =>
      Number(
        (
          await client.query<{ on_hand: number }>(
            `SELECT on_hand FROM club_product_stock WHERE product_id = $1`,
            [productId],
          )
        ).rows[0]?.on_hand,
      );
    // Sold more than was ever recorded: below zero, shown, never refused.
    expect(await onHand()).toBe(-2);
    await move('adjust', 5);
    expect(await onHand()).toBe(3);
    expect((await failure(move('receive', -1))).constraint).toBe(
      'club_stock_movements_sign_matches_kind',
    );
    expect((await failure(move('sale', -1))).constraint).toBe('club_stock_movements_sale_pair');
    expect(
      (
        await failure(
          client.query(`UPDATE club_stock_movements SET quantity = 1 WHERE product_id = $1`, [
            productId,
          ]),
        )
      ).message,
    ).toMatch(/append-only/);
    expect((await failure(client.query(`TRUNCATE club_stock_movements`))).message).toMatch(
      /truncate|append-only|ledger/i,
    );
  });

  it('keeps an offer use when the client and their membership are erased', async () => {
    const promotion =
      (
        await client.query<{ id: string }>(
          `INSERT INTO club_promotions (club_id, name, code, kind, value, starts_on, max_uses)
           VALUES ($1, 'Ваучер', 'GIFT-0001', 'amount', 500, current_date, 1) RETURNING id`,
          [club.clubId],
        )
      ).rows[0]?.id ?? '';
    const plan = await makePlan(client, club.clubId);
    const { membershipId } = await sellMembership(client, club.clubId, memberId, plan);
    await client.query(
      `INSERT INTO club_promotion_redemptions (club_id, promotion_id, subject, member_id,
                                               membership_id, discount_cents)
       VALUES ($1, $2, 'membership', $3, $4, 500)`,
      [club.clubId, promotion, memberId, membershipId],
    );
    // The same membership is discounted once.
    const twice = await failure(
      client.query(
        `INSERT INTO club_promotion_redemptions (club_id, promotion_id, subject, membership_id,
                                                 discount_cents)
         VALUES ($1, $2, 'membership', $3, 100)`,
        [club.clubId, promotion, membershipId],
      ),
    );
    expect(twice.constraint).toBe('club_promotion_redemptions_membership_unique');
    await client.query(`DELETE FROM club_members WHERE id = $1`, [memberId]);
    const left = await client.query<{
      subject: string;
      member_id: string | null;
      membership_id: string | null;
    }>(
      `SELECT subject, member_id, membership_id FROM club_promotion_redemptions WHERE promotion_id = $1`,
      [promotion],
    );
    expect(left.rows).toEqual([{ subject: 'membership', member_id: null, membership_id: null }]);
    expect(
      (
        await failure(
          client.query(`DELETE FROM club_promotion_redemptions WHERE promotion_id = $1`, [
            promotion,
          ]),
        )
      ).message,
    ).toMatch(/append-only/);
  });

  it("fixes an online purchase's offer once the checkout exists", async () => {
    const plan = await makePlan(client, club.clubId);
    const promotion =
      (
        await client.query<{ id: string }>(
          `INSERT INTO club_promotions (club_id, name, kind, value, starts_on)
           VALUES ($1, 'Есен', 'percent', 1000, current_date) RETURNING id`,
          [club.clubId],
        )
      ).rows[0]?.id ?? '';
    const checkout =
      (
        await client.query<{ id: string }>(
          `INSERT INTO club_checkouts (club_id, purpose, member_id, plan_id, starts_on, amount_cents,
                                       provider, account_ref, promotion_id, discount_cents)
           VALUES ($1, 'membership', $2, $3, current_date, 4500, 'fake',
                   'acct_fake_0123456789abcdef', $4, 500) RETURNING id`,
          [club.clubId, memberId, plan, promotion],
        )
      ).rows[0]?.id ?? '';
    expect(
      (
        await failure(
          client.query(`UPDATE club_checkouts SET discount_cents = 4000 WHERE id = $1`, [checkout]),
        )
      ).message,
    ).toMatch(/never changes/);
    // An offer with no discount, or on a charge payment, is refused.
    const unpaired = await failure(
      client.query(
        `INSERT INTO club_checkouts (club_id, purpose, member_id, plan_id, starts_on, amount_cents,
                                     provider, account_ref, promotion_id)
         VALUES ($1, 'membership', $2, $3, current_date, 4500, 'fake', 'acct_fake_0123456789abcdef', $4)`,
        [club.clubId, memberId, plan, promotion],
      ),
    );
    expect(unpaired.constraint).toBe('club_checkouts_promotion_pair');
  });

  it('never reaches into another club', async () => {
    const other = await makeClub(client, 'shop-other');
    const foreign =
      (
        await client.query<{ id: string }>(
          `INSERT INTO club_products (club_id, name, price_cents) VALUES ($1, 'Чужд', 100) RETURNING id`,
          [other.clubId],
        )
      ).rows[0]?.id ?? '';
    const saleId = await sale(await nextNumber());
    const line = await failure(
      client.query(
        `INSERT INTO club_sale_lines (club_id, sale_id, line_no, product_id, name, unit_price_cents,
                                      quantity, total_cents, vat_rate_bp)
         VALUES ($1, $2, 2, $3, 'Чужд', 100, 1, 100, 2000)`,
        [club.clubId, saleId, foreign],
      ),
    );
    expect(line.code).toBe('23503');
    const move = await failure(
      client.query(
        `INSERT INTO club_stock_movements (club_id, product_id, kind, quantity) VALUES ($1, $2, 'receive', 1)`,
        [club.clubId, foreign],
      ),
    );
    expect(move.code).toBe('23503');
  });

  it('refuses a use that names the wrong thing, and a delete of what has history', async () => {
    const promotion =
      (
        await client.query<{ id: string }>(
          `INSERT INTO club_promotions (club_id, name, kind, value, starts_on)
           VALUES ($1, 'Есен', 'percent', 1000, current_date) RETURNING id`,
          [club.clubId],
        )
      ).rows[0]?.id ?? '';
    const use = (
      subject: string,
      member: string | null,
      membership: string | null,
      saleId: string | null,
    ) =>
      client.query(
        `INSERT INTO club_promotion_redemptions (club_id, promotion_id, subject, member_id,
                                                 membership_id, sale_id, discount_cents)
         VALUES ($1, $2, $3, $4, $5, $6, 100)`,
        [club.clubId, promotion, subject, member, membership, saleId],
      );
    // A membership use names its membership…
    expect((await failure(use('membership', memberId, null, null))).constraint).toBe(
      'club_promotion_redemptions_membership_named',
    );
    // …and that membership is the same client's.
    const plan = await makePlan(client, club.clubId);
    const { membershipId } = await sellMembership(client, club.clubId, memberId, plan);
    const someoneElse = await makeMember(client, club.clubId, 'Иван');
    expect((await failure(use('membership', someoneElse, membershipId, null))).code).toBe('23503');
    // A sale use names no membership.
    const saleId = await sale(await nextNumber());
    expect((await failure(use('sale', memberId, membershipId, saleId))).constraint).toBe(
      'club_promotion_redemptions_membership_only',
    );
    await use('sale', memberId, null, saleId);
    // A product that was sold cannot be deleted: its key refuses.
    expect(
      (await failure(client.query(`DELETE FROM club_products WHERE id = $1`, [productId]))).code,
    ).toBe('23503');
    // Nor an offer, used or not.
    expect(
      (await failure(client.query(`DELETE FROM club_promotions WHERE id = $1`, [promotion])))
        .message,
    ).toMatch(/archived, never deleted/);
  });
});

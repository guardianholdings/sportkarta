import { getDb, sql, type SQL } from '@sportkarta/db';
import { sofiaToday, type IsoDate } from '@sportkarta/lib/clubs';

import { recordClubAudit } from './audit';
import { violatedConstraint } from './errors';
import { clubFeatureSql, walletMethodAllowed } from './features';
import type { ClubProductCategory, ProductInput, StockInput, TillSaleInput } from './input';
import { closeChargeCheckout } from './payments';
import { liveInvoiceFor } from './invoices';
import { previewOffer, recordRedemption, resolveOffer } from './promotions';
import { saleErrorCode } from './sales';
import { clubActorMay, clubScope, clubWriteScope, type ClubActor } from './scope';

/**
 * The club's shop (0049, wave B1): products and their stock, and the till.
 *
 * A till sale is ONE transaction: the next gapless sale number, the lines as
 * snapshots, the stock leaving the shelf, one ordinary `product` charge for
 * the total (none when an offer makes it free), the payment — or the charge
 * left open on the client's account — and the offer's use. Prices, stock and
 * the offer are read here, never taken from the form. It is not a fiscal
 * receipt («Не е фискален бон»); the whole shop sits behind the `shop`
 * feature and CLUB_SHOP_ENABLED.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export interface ClubProduct {
  id: string;
  name: string;
  sku: string | null;
  category: ClubProductCategory;
  priceCents: number;
  vatRateBp: number;
  trackStock: boolean;
  lowStockAt: number | null;
  sortOrder: number;
  archived: boolean;
  onHand: number;
}

/** The shelf — for the till (shop.sell) and the products screen. */
export async function clubProducts(
  actor: ClubActor,
  options: { includeArchived?: boolean } = {},
): Promise<ClubProduct[]> {
  const result = await getDb().execute(sql`
    SELECT pd.id, pd.name, pd.sku, pd.category, pd.price_cents, pd.vat_rate_bp, pd.track_stock,
           pd.low_stock_at, pd.sort_order, pd.archived_at IS NOT NULL AS archived, st.on_hand
      FROM club_products pd
      JOIN club_product_stock st ON st.product_id = pd.id
     WHERE ${clubScope(actor, 'shop.sell', 'pd')}
       AND ${options.includeArchived ? sql`true` : sql`pd.archived_at IS NULL`}
     ORDER BY pd.archived_at IS NOT NULL, pd.category, pd.sort_order, pd.name
     LIMIT 1000
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    sku: text(row.sku),
    category: String(row.category) as ClubProductCategory,
    priceCents: Number(row.price_cents),
    vatRateBp: Number(row.vat_rate_bp),
    trackStock: row.track_stock === true,
    lowStockAt: row.low_stock_at === null ? null : Number(row.low_stock_at),
    sortOrder: Number(row.sort_order),
    archived: row.archived === true,
    onHand: Number(row.on_hand ?? 0),
  }));
}

export type SaveProductResult =
  { ok: true; productId: string } | { ok: false; error: 'not_allowed' | 'sku_taken' };

/** Create (id null) or edit a product. shop.manage on a tier with the shop. */
export async function saveProduct(
  db: TransactionalDb,
  actor: ClubActor,
  productId: string | null,
  input: ProductInput,
): Promise<SaveProductResult> {
  try {
    return await db.transaction(async (tx) => {
      const values = sql`${input.name}, ${input.sku}, ${input.category}, ${input.priceCents},
        ${input.vatRateBp}, ${input.trackStock}, ${input.lowStockAt}, ${input.sortOrder}`;
      const saved = await tx.execute(
        productId === null
          ? sql`
              INSERT INTO club_products (club_id, name, sku, category, price_cents, vat_rate_bp,
                                         track_stock, low_stock_at, sort_order)
              SELECT ${actor.clubId}::uuid, ${values}
               WHERE ${clubActorMay(actor, 'shop.manage', { write: true })}
                 AND ${clubFeatureSql(actor.clubId, 'shop')}
              RETURNING id`
          : sql`
              UPDATE club_products pd
                 SET (name, sku, category, price_cents, vat_rate_bp, track_stock, low_stock_at,
                      sort_order) = (${values})
               WHERE pd.id = ${productId}::uuid
                 AND ${clubWriteScope(actor, 'shop.manage', 'pd')}
                 AND ${clubFeatureSql(actor.clubId, 'shop')}
              RETURNING pd.id`,
      );
      const id = text(saved.rows[0]?.id);
      if (!id) return { ok: false, error: 'not_allowed' } as const;
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'product_saved',
        detail: { productId: id, priceCents: input.priceCents },
      });
      return { ok: true, productId: id } as const;
    });
  } catch (error: unknown) {
    if (violatedConstraint(error) === 'club_products_sku_unique') {
      return { ok: false, error: 'sku_taken' };
    }
    throw error;
  }
}

/** Archive a product, or bring it back — unless its SKU now belongs to another. */
export async function setProductArchived(
  db: TransactionalDb,
  actor: ClubActor,
  productId: string,
  archived: boolean,
): Promise<'ok' | 'not_found' | 'sku_taken'> {
  try {
    return await db.transaction(async (tx) => {
      const updated = await tx.execute(sql`
        UPDATE club_products pd SET archived_at = ${archived ? sql`now()` : sql`NULL`}
         WHERE pd.id = ${productId}::uuid AND (pd.archived_at IS NULL) = ${archived}
           AND ${clubWriteScope(actor, 'shop.manage', 'pd')}
        RETURNING pd.id
      `);
      if (updated.rows.length === 0) return 'not_found' as const;
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'product_archived',
        detail: { productId, archived },
      });
      return 'ok' as const;
    });
  } catch (error: unknown) {
    if (violatedConstraint(error) === 'club_products_sku_unique') return 'sku_taken';
    throw error;
  }
}

/** The ledger's bound on one movement (club_stock_movements_quantity_sane). */
const MAX_MOVEMENT = 100_000;

/**
 * A delivery, a write-off, or a COUNT: the shelf holds N, so the ledger gets
 * the difference as an adjustment. The count locks the product's row in a
 * mode that conflicts with the SHARE lock every till sale and reversal takes
 * on the products it moves — so a sale at the same moment is wholly before
 * the count (and the on-hand read, a later statement, sees it) or wholly
 * after it.
 */
export async function recordStock(
  db: TransactionalDb,
  actor: ClubActor,
  input: StockInput,
): Promise<'ok' | 'not_allowed' | 'unchanged' | 'too_large'> {
  return db.transaction(async (tx) => {
    const product = (
      await tx.execute(sql`
        SELECT pd.id FROM club_products pd
         WHERE pd.id = ${input.productId}::uuid AND pd.archived_at IS NULL AND pd.track_stock
           AND ${clubWriteScope(actor, 'shop.manage', 'pd')}
           AND ${clubFeatureSql(actor.clubId, 'shop')}
           FOR NO KEY UPDATE
      `)
    ).rows[0];
    if (!product) return 'not_allowed';
    let kind: 'receive' | 'waste' | 'adjust';
    let quantity: number;
    if (input.kind === 'count') {
      const onHand = Number(
        (
          await tx.execute(sql`
            SELECT on_hand FROM club_product_stock WHERE product_id = ${input.productId}::uuid
          `)
        ).rows[0]?.on_hand ?? 0,
      );
      quantity = input.quantity - onHand;
      if (quantity === 0) return 'unchanged';
      if (Math.abs(quantity) > MAX_MOVEMENT) return 'too_large';
      kind = 'adjust';
    } else {
      kind = input.kind;
      quantity = input.kind === 'waste' ? -input.quantity : input.quantity;
    }
    await tx.execute(sql`
      INSERT INTO club_stock_movements (club_id, product_id, kind, quantity, unit_cost_cents,
                                        recorded_by)
      SELECT pd.club_id, pd.id, ${kind}, ${quantity},
             ${kind === 'receive' ? input.unitCostCents : null}, ${actor.userId}
        FROM club_products pd
       WHERE pd.id = ${input.productId}::uuid AND ${clubWriteScope(actor, 'shop.manage', 'pd')}
    `);
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'stock_moved',
      detail: { productId: input.productId, kind, quantity },
    });
    return 'ok';
  });
}

export type TillSaleResult =
  | { ok: true; saleId: string; number: number; totalCents: number; discountCents: number }
  | { ok: false; error: string };

class Refused extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** The ledger's bound on one sale (club_sales_totals_sane). */
const MAX_SALE_CENTS = 10_000_000;

/**
 * Ring up a sale at the till. `label(n)` names the charge in the club's own
 * words («Продажба №n») — the caller's, so this module holds no copy.
 * Refusals: not_allowed, member_unavailable, product_unavailable,
 * sale_too_large, code_invalid, offer_used_up.
 */
export async function recordTillSale(
  db: TransactionalDb,
  actor: ClubActor,
  input: TillSaleInput,
  label: (saleNumber: number) => string,
  today: IsoDate = sofiaToday(),
): Promise<TillSaleResult> {
  try {
    return await db.transaction(async (tx) => {
      const allowed = await tx.execute(sql`
        SELECT 1 WHERE ${clubActorMay(actor, 'shop.sell', { write: true })}
                   AND ${clubFeatureSql(actor.clubId, 'shop')}
      `);
      if (allowed.rows.length === 0) throw new Refused('not_allowed');
      if (input.memberId !== null) {
        const member = await tx.execute(sql`
          SELECT m.id FROM club_members m
           WHERE m.id = ${input.memberId}::uuid AND m.archived_at IS NULL
             AND ${clubScope(actor, 'shop.sell', 'm')}
        `);
        if (member.rows.length === 0) throw new Refused('member_unavailable');
      }
      if (input.locationId !== null) {
        const location = await tx.execute(sql`
          SELECT l.id FROM club_locations l
           WHERE l.id = ${input.locationId}::uuid AND ${clubScope(actor, 'shop.sell', 'l')}
        `);
        if (location.rows.length === 0) throw new Refused('not_allowed');
      }
      const ids = input.lines.map((line) => line.productId);
      // SHARE on the products, in id order: a stock count (NO KEY UPDATE)
      // waits for this sale, or this sale for the count — never both at once.
      const products = await tx.execute(sql`
        SELECT pd.id, pd.name, pd.price_cents, pd.vat_rate_bp, pd.track_stock
          FROM club_products pd
         WHERE pd.club_id = ${actor.clubId}::uuid AND pd.archived_at IS NULL
           AND pd.id = ANY(${sql.param(ids)}::uuid[])
         ORDER BY pd.id
           FOR SHARE
      `);
      const byId = new Map(products.rows.map((row) => [String(row.id), row]));
      if (byId.size !== ids.length) throw new Refused('product_unavailable');
      const lines = input.lines.map((line) => {
        const row = byId.get(line.productId) ?? {};
        return {
          productId: line.productId,
          quantity: line.quantity,
          name: String(row.name),
          unitPriceCents: Number(row.price_cents),
          vatRateBp: Number(row.vat_rate_bp),
          trackStock: row.track_stock === true,
        };
      });
      const subtotal = lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);
      if (subtotal > MAX_SALE_CENTS) throw new Refused('sale_too_large');
      const offer = await resolveOffer(
        tx,
        actor.clubId,
        lines.map((line) => ({
          kind: 'product' as const,
          id: line.productId,
          unitPriceCents: line.unitPriceCents,
          quantity: line.quantity,
        })),
        input.memberId,
        input.code,
        today,
      );
      if (!offer.ok) throw new Refused(offer.error);
      const discounts = offer.applied?.discounts ?? lines.map(() => 0);
      const discount = discounts.reduce((sum, d) => sum + d, 0);
      const total = subtotal - discount;
      // The next number, gapless: the row stays locked until this commits.
      const number = Number(
        (
          await tx.execute(sql`
            INSERT INTO club_number_sequences (club_id, kind, last_value)
            SELECT ${actor.clubId}::uuid, 'sale', 1
             WHERE ${clubActorMay(actor, 'shop.sell', { write: true })}
            ON CONFLICT (club_id, kind) DO UPDATE
              SET last_value = club_number_sequences.last_value + 1
            RETURNING last_value
          `)
        ).rows[0]?.last_value,
      );
      if (!Number.isSafeInteger(number) || number < 1) throw new Refused('not_allowed');
      let chargeId: string | null = null;
      if (total > 0) {
        chargeId = text(
          (
            await tx.execute(sql`
              INSERT INTO club_charges (club_id, member_id, kind, label, amount_cents, issued_on,
                                        due_on, created_by)
              SELECT ${actor.clubId}::uuid, ${input.memberId}::uuid, 'product',
                     ${label(number).slice(0, 120)}, ${total}, ${today}::date, ${today}::date,
                     ${actor.userId}
               WHERE ${clubActorMay(actor, 'shop.sell', { write: true })}
              RETURNING id
            `)
          ).rows[0]?.id,
        );
      }
      const saleId = String(
        (
          await tx.execute(sql`
            INSERT INTO club_sales (club_id, number, member_id, location_id, charge_id,
                                    subtotal_cents, discount_cents, total_cents, sold_by)
            SELECT ${actor.clubId}::uuid, ${number}, ${input.memberId}::uuid,
                   ${input.locationId}::uuid, ${chargeId}::uuid, ${subtotal}, ${discount}, ${total},
                   ${actor.userId}
             WHERE ${clubActorMay(actor, 'shop.sell', { write: true })}
            RETURNING id
          `)
        ).rows[0]?.id,
      );
      for (const [index, line] of lines.entries()) {
        const lineDiscount = discounts[index] ?? 0;
        await tx.execute(sql`
          INSERT INTO club_sale_lines (club_id, sale_id, line_no, product_id, name,
                                       unit_price_cents, quantity, discount_cents, total_cents,
                                       vat_rate_bp)
          SELECT ${actor.clubId}::uuid, ${saleId}::uuid, ${index + 1}, ${line.productId}::uuid,
                 ${line.name}, ${line.unitPriceCents}, ${line.quantity}, ${lineDiscount},
                 ${line.unitPriceCents * line.quantity - lineDiscount}, ${line.vatRateBp}
           WHERE ${clubActorMay(actor, 'shop.sell', { write: true })}
        `);
        if (line.trackStock) {
          await tx.execute(sql`
            INSERT INTO club_stock_movements (club_id, product_id, kind, quantity, sale_id,
                                              recorded_by)
            SELECT ${actor.clubId}::uuid, ${line.productId}::uuid, 'sale', ${-line.quantity},
                   ${saleId}::uuid, ${actor.userId}
             WHERE ${clubActorMay(actor, 'shop.sell', { write: true })}
          `);
        }
      }
      if (chargeId !== null && input.method !== null) {
        const paid = await tx.execute(sql`
          INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method,
                                     received_on, recorded_by)
          SELECT ${actor.clubId}::uuid, ${chargeId}::uuid, ${input.memberId}::uuid, 'payment',
                 ${total}, ${input.method}, ${today}::date, ${actor.userId}
           WHERE ${clubActorMay(actor, 'shop.sell', { write: true })}
             AND ${walletMethodAllowed(actor.clubId, input.method)}
          RETURNING id
        `);
        if (paid.rows.length === 0) throw new Refused('feature_unavailable');
      }
      if (offer.applied && discount > 0) {
        await recordRedemption(tx, {
          clubId: actor.clubId,
          promotionId: offer.applied.promotion.id,
          memberId: input.memberId,
          subject: { saleId },
          discountCents: discount,
        });
      }
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'sale_recorded',
        subjectMemberId: input.memberId,
        detail: {
          saleId,
          number,
          totalCents: total,
          paid: input.method !== null,
          promotionId: offer.applied?.promotion.id ?? null,
        },
      });
      return { ok: true, saleId, number, totalCents: total, discountCents: discount } as const;
    });
  } catch (error: unknown) {
    if (error instanceof Refused) return { ok: false, error: error.code };
    const code = saleErrorCode(error);
    if (code) return { ok: false, error: code };
    throw error;
  }
}

/**
 * «Сторно»: undo a whole till sale. The goods its sale movements took go
 * back on the shelf, desk money already taken is refunded, and the charge is
 * voided so nothing stays owed. Once. charges.void (owner, manager) — the
 * people who may void any charge. Money paid ONLINE (a tab settled through
 * Stripe) is refused here: it goes back through the online refund first,
 * since a desk refund row would record money that never left Stripe; so is
 * an invoiced sale, until its credit note is issued. After commit the
 * charge's open online checkout, if any, is closed.
 */
export async function reverseSale(
  db: TransactionalDb,
  actor: ClubActor,
  saleId: string,
  today: IsoDate = sofiaToday(),
): Promise<'ok' | 'not_found' | 'paid_online' | 'invoice_live'> {
  const outcome = await db.transaction(async (tx) => {
    const sale = (
      await tx.execute(sql`
        SELECT sa.charge_id, sa.member_id, sa.number FROM club_sales sa
         WHERE sa.id = ${saleId}::uuid AND sa.reversed_at IS NULL
           AND ${clubWriteScope(actor, 'charges.void', 'sa')}
      `)
    ).rows[0];
    if (!sale) return { result: 'not_found' as const };
    const chargeId = text(sale.charge_id);
    // The charge first — the order every money path locks in.
    if (chargeId !== null) {
      await tx.execute(sql`
        SELECT ch.id FROM club_charges ch
         WHERE ch.club_id = ${actor.clubId}::uuid AND ch.id = ${chargeId}::uuid
           FOR NO KEY UPDATE
      `);
    }
    const money =
      chargeId === null
        ? []
        : (
            await tx.execute(sql`
              SELECT pp.method, sum(pp.amount_cents)::int AS net
                FROM club_payments pp
               WHERE pp.club_id = ${actor.clubId}::uuid AND pp.charge_id = ${chargeId}::uuid
               GROUP BY pp.method
            `)
          ).rows.map((row) => ({ method: String(row.method), net: Number(row.net) }));
    if (money.some((m) => m.method === 'card_online' && m.net !== 0)) {
      return { result: 'paid_online' as const };
    }
    // An invoiced sale is cancelled by its credit note first (0050).
    if (chargeId !== null) {
      const invoiced = await tx.execute(sql`
        SELECT 1 FROM club_charges ch
         WHERE ch.club_id = ${actor.clubId}::uuid AND ch.id = ${chargeId}::uuid
           AND ${liveInvoiceFor(sql`ch.club_id`, sql`ch.id`)}
      `);
      if (invoiced.rows.length > 0) return { result: 'invoice_live' as const };
    }
    const reversed = await tx.execute(sql`
      UPDATE club_sales sa SET reversed_at = now(), reversed_by = ${actor.userId}
       WHERE sa.id = ${saleId}::uuid AND sa.reversed_at IS NULL
         AND ${clubWriteScope(actor, 'charges.void', 'sa')}
      RETURNING sa.id
    `);
    if (reversed.rows.length === 0) return { result: 'not_found' as const };
    // What THIS sale took off the shelf comes back — whatever the product's
    // stock tracking says today. SHARE on those products first, as a sale does.
    await tx.execute(sql`
      SELECT pd.id FROM club_products pd
       WHERE pd.club_id = ${actor.clubId}::uuid
         AND pd.id IN (SELECT mv.product_id FROM club_stock_movements mv
                        WHERE mv.club_id = ${actor.clubId}::uuid AND mv.sale_id = ${saleId}::uuid)
       ORDER BY pd.id
         FOR SHARE
    `);
    await tx.execute(sql`
      INSERT INTO club_stock_movements (club_id, product_id, kind, quantity, sale_id, recorded_by)
      SELECT mv.club_id, mv.product_id, 'return', -mv.quantity, mv.sale_id, ${actor.userId}
        FROM club_stock_movements mv
       WHERE mv.club_id = ${actor.clubId}::uuid AND mv.sale_id = ${saleId}::uuid
         AND mv.kind = 'sale'
         AND ${clubActorMay(actor, 'charges.void', { write: true })}
    `);
    if (chargeId !== null) {
      // What is still on the charge goes back the way it came, never more in
      // total than is there: the credit spent on it first, back to the
      // credit; then the money, method by method, never more than the money
      // paid (spent credit never leaves as money — 0050's
      // club_payments_wallet_cash_back). A method already refunded past what
      // it took (a negative net) lowers what the others give back.
      let left = money.reduce((sum, m) => sum + m.net, 0);
      const credit = money.find((m) => m.method === 'wallet')?.net ?? 0;
      const cash = money.filter((m) => m.method !== 'wallet').reduce((sum, m) => sum + m.net, 0);
      const backs: { method: string; back: number }[] = [];
      if (credit > 0 && left > 0) {
        backs.push({ method: 'wallet', back: Math.min(credit, left) });
        left -= Math.min(credit, left);
      }
      left = Math.min(left, Math.max(0, cash));
      for (const { method, net } of money
        .filter((m) => m.method !== 'wallet')
        .sort((a, b) => b.net - a.net)) {
        if (left <= 0 || net <= 0) break;
        backs.push({ method, back: Math.min(net, left) });
        left -= Math.min(net, left);
      }
      for (const { method, back } of backs) {
        await tx.execute(sql`
          INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method,
                                     received_on, recorded_by)
          SELECT ch.club_id, ch.id, ${text(sale.member_id)}::uuid, 'refund', ${-back}, ${method},
                 ${today}::date, ${actor.userId}
            FROM club_charges ch
           WHERE ch.club_id = ${actor.clubId}::uuid AND ch.id = ${chargeId}::uuid
             AND ${clubWriteScope(actor, 'charges.void', 'ch')}
        `);
      }
      await tx.execute(sql`
        UPDATE club_charges ch SET voided_at = now()
         WHERE ch.club_id = ${actor.clubId}::uuid AND ch.id = ${chargeId}::uuid
           AND ch.voided_at IS NULL AND ${clubWriteScope(actor, 'charges.void', 'ch')}
      `);
    }
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'sale_reversed',
      subjectMemberId: text(sale.member_id),
      detail: { saleId, number: Number(sale.number) },
    });
    return { result: 'ok' as const, chargeId };
  });
  // A tab the member could still be paying online must stop taking money.
  if (outcome.result === 'ok' && outcome.chargeId) {
    await closeChargeCheckout(actor.clubId, outcome.chargeId);
  }
  return outcome.result;
}

export type TillPreview =
  | {
      ok: true;
      subtotalCents: number;
      discountCents: number;
      totalCents: number;
      offerName: string | null;
    }
  | { ok: false; error: string };

/**
 * What the till WILL charge for this cart, before it is recorded — the same
 * prices and the same offer decision as recordTillSale (previewOffer), so the
 * cashier collects the amount the books will hold. Writes nothing.
 */
export async function previewTillSale(
  db: TransactionalDb,
  actor: ClubActor,
  input: Pick<TillSaleInput, 'lines' | 'memberId' | 'code'>,
  today: IsoDate = sofiaToday(),
): Promise<TillPreview> {
  const ids = input.lines.map((line) => line.productId);
  const products = await db.execute(sql`
    SELECT pd.id, pd.price_cents FROM club_products pd
     WHERE ${clubScope(actor, 'shop.sell', 'pd')} AND pd.archived_at IS NULL
       AND pd.id = ANY(${sql.param(ids)}::uuid[])
  `);
  const price = new Map(products.rows.map((row) => [String(row.id), Number(row.price_cents)]));
  if (price.size !== ids.length) return { ok: false, error: 'product_unavailable' };
  const items = input.lines.map((line) => ({
    kind: 'product' as const,
    id: line.productId,
    unitPriceCents: price.get(line.productId) ?? 0,
    quantity: line.quantity,
  }));
  const subtotal = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  if (subtotal > MAX_SALE_CENTS) return { ok: false, error: 'sale_too_large' };
  if (input.memberId !== null) {
    const member = await db.execute(sql`
      SELECT m.id FROM club_members m
       WHERE m.id = ${input.memberId}::uuid AND m.archived_at IS NULL
         AND ${clubScope(actor, 'shop.sell', 'm')}
    `);
    if (member.rows.length === 0) return { ok: false, error: 'member_unavailable' };
  }
  const offer = await previewOffer(db, actor.clubId, items, input.memberId, input.code, today);
  if (!offer.ok) return { ok: false, error: offer.error };
  const discount = offer.applied?.totalDiscountCents ?? 0;
  return {
    ok: true,
    subtotalCents: subtotal,
    discountCents: discount,
    totalCents: subtotal - discount,
    offerName: discount > 0 ? (offer.applied?.promotion.name ?? null) : null,
  };
}

export interface SaleSummary {
  id: string;
  number: number;
  soldAt: string;
  memberId: string | null;
  memberName: string | null;
  totalCents: number;
  discountCents: number;
  /** The charge's status (open = on account, paid, partial, overdue, void); a free sale: paid. */
  status: string;
  reversed: boolean;
}

/** The till's recent sales. */
export async function recentSales(actor: ClubActor, limit = 100): Promise<SaleSummary[]> {
  const result = await getDb().execute(sql`
    SELECT sa.id, sa.number, sa.sold_at, sa.member_id, m.display_name, sa.total_cents,
           sa.discount_cents, sa.reversed_at IS NOT NULL AS reversed, cb.status
      FROM club_sales sa
      LEFT JOIN club_members m ON m.club_id = sa.club_id AND m.id = sa.member_id
      LEFT JOIN club_charge_balances cb ON cb.charge_id = sa.charge_id
     WHERE ${clubScope(actor, 'shop.sell', 'sa')}
     ORDER BY sa.sold_at DESC, sa.number DESC
     LIMIT ${limit}
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    number: Number(row.number),
    soldAt: iso(row.sold_at),
    memberId: text(row.member_id),
    memberName: text(row.display_name),
    totalCents: Number(row.total_cents),
    discountCents: Number(row.discount_cents),
    status: text(row.status) ?? 'paid',
    reversed: row.reversed === true,
  }));
}

export interface SaleDetail extends SaleSummary {
  subtotalCents: number;
  promotionName: string | null;
  lines: {
    name: string;
    quantity: number;
    unitPriceCents: number;
    discountCents: number;
    totalCents: number;
  }[];
  /** Per method: money taken, and money given back (a reversal). */
  payments: { method: string; amountCents: number; refundedCents: number }[];
  /** The charge it raised (none when free), and that charge's live invoice (0050). */
  chargeId: string | null;
  invoiceId: string | null;
}

export async function saleById(actor: ClubActor, saleId: string): Promise<SaleDetail | null> {
  const db = getDb();
  const head = (
    await db.execute(sql`
      SELECT sa.id, sa.number, sa.sold_at, sa.member_id, m.display_name, sa.subtotal_cents,
             sa.total_cents, sa.discount_cents, sa.reversed_at IS NOT NULL AS reversed,
             cb.status, sa.charge_id,
             (SELECT i.id FROM club_invoices i
               WHERE i.club_id = sa.club_id AND i.charge_id = sa.charge_id AND i.kind = 'invoice'
                 AND i.total_cents > coalesce((SELECT sum(c.total_cents) FROM club_invoices c
                                                WHERE c.club_id = i.club_id AND c.corrects_id = i.id), 0)
               LIMIT 1) AS invoice_id,
             (SELECT po.name FROM club_promotion_redemptions rd
                JOIN club_promotions po ON po.club_id = rd.club_id AND po.id = rd.promotion_id
               WHERE rd.club_id = sa.club_id AND rd.sale_id = sa.id) AS promotion
        FROM club_sales sa
        LEFT JOIN club_members m ON m.club_id = sa.club_id AND m.id = sa.member_id
        LEFT JOIN club_charge_balances cb ON cb.charge_id = sa.charge_id
       WHERE sa.id = ${saleId}::uuid AND ${clubScope(actor, 'shop.sell', 'sa')}
    `)
  ).rows[0];
  if (!head) return null;
  const chargeId = text(head.charge_id);
  const [lines, payments] = await Promise.all([
    db.execute(sql`
      SELECT sl.name, sl.quantity, sl.unit_price_cents, sl.discount_cents, sl.total_cents
        FROM club_sale_lines sl
       WHERE sl.club_id = ${actor.clubId}::uuid AND sl.sale_id = ${saleId}::uuid
       ORDER BY sl.line_no
    `),
    chargeId === null
      ? Promise.resolve({ rows: [] as Record<string, unknown>[] })
      : db.execute(sql`
          SELECT pp.method,
                 sum(pp.amount_cents) FILTER (WHERE pp.kind = 'payment')::int AS amount,
                 coalesce(-sum(pp.amount_cents) FILTER (WHERE pp.kind = 'refund'), 0)::int AS refunded
            FROM club_payments pp
           WHERE pp.club_id = ${actor.clubId}::uuid AND pp.charge_id = ${chargeId}::uuid
           GROUP BY pp.method ORDER BY pp.method
        `),
  ]);
  return {
    id: String(head.id),
    number: Number(head.number),
    soldAt: iso(head.sold_at),
    memberId: text(head.member_id),
    memberName: text(head.display_name),
    subtotalCents: Number(head.subtotal_cents),
    totalCents: Number(head.total_cents),
    discountCents: Number(head.discount_cents),
    status: text(head.status) ?? 'paid',
    reversed: head.reversed === true,
    promotionName: text(head.promotion),
    lines: lines.rows.map((row) => ({
      name: String(row.name),
      quantity: Number(row.quantity),
      unitPriceCents: Number(row.unit_price_cents),
      discountCents: Number(row.discount_cents),
      totalCents: Number(row.total_cents),
    })),
    payments: payments.rows.map((row) => ({
      method: String(row.method),
      amountCents: Number(row.amount ?? 0),
      refundedCents: Number(row.refunded ?? 0),
    })),
    chargeId,
    invoiceId: text(head.invoice_id),
  };
}

export interface BestSeller {
  productId: string;
  name: string;
  quantity: number;
  revenueCents: number;
}

/** What sold most over the last `days` days — reversed sales do not count. */
export async function bestSellers(actor: ClubActor, days = 30): Promise<BestSeller[]> {
  const result = await getDb().execute(sql`
    SELECT sl.product_id, max(sl.name) AS name, sum(sl.quantity)::int AS quantity,
           sum(sl.total_cents)::int AS revenue
      FROM club_sale_lines sl
      JOIN club_sales sa ON sa.club_id = sl.club_id AND sa.id = sl.sale_id
     WHERE ${clubScope(actor, 'shop.sell', 'sa')} AND sa.reversed_at IS NULL
       AND sa.sold_at >= now() - make_interval(days => ${days}::int)
     GROUP BY sl.product_id
     ORDER BY quantity DESC, revenue DESC
     LIMIT 10
  `);
  return result.rows.map((row) => ({
    productId: String(row.product_id),
    name: String(row.name),
    quantity: Number(row.quantity),
    revenueCents: Number(row.revenue),
  }));
}

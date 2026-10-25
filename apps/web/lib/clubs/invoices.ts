import { getDb, sql, type SQL } from '@sportkarta/db';
import {
  INVOICE_VAT_RATES,
  invoiceLines,
  invoiceTotals,
  sofiaToday,
  type InvoiceBuyerKind,
  type InvoiceLine,
  type InvoiceLineInput,
  type InvoicePaymentMethod,
  type InvoiceTotals,
  type InvoiceVatRate,
  type IsoDate,
} from '@sportkarta/lib/clubs';

import { recordClubAudit } from './audit';
import { violatedConstraint } from './errors';
import { clubFeatureSql } from './features';
import { clubActorMay, clubScope, type ClubActor } from './scope';

/**
 * Invoices and credit notes (0050, wave B2). An invoice is issued FROM a
 * charge — a till sale's lines, or the charge itself as one line — to the
 * client or a company, with the club's details as they are that day; the
 * VAT split is lib's pure arithmetic, so the draft the office checks is the
 * document it gets. Never edited: a mistake is cancelled by a credit note.
 * Owner and manager (invoices.issue), on a tier with invoices — which also
 * waits for CLUB_SHOP_ENABLED, the accountant's switch.
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

function day(value: unknown): IsoDate {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function rate(value: unknown): InvoiceVatRate | null {
  const n = Number(value);
  return value !== null && (INVOICE_VAT_RATES as readonly number[]).includes(n)
    ? (n as InvoiceVatRate)
    : null;
}

/**
 * SQL: the charge (by its club and id expressions) has a live invoice — one
 * not wholly corrected by credit notes. Money taken back from such a charge
 * (a void, a reversal, a refund) waits for the credit note: otherwise the
 * club declares a sale that never happened.
 */
export function liveInvoiceFor(clubId: SQL, chargeId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM club_invoices li
                      WHERE li.club_id = ${clubId} AND li.charge_id = ${chargeId}
                        AND li.kind = 'invoice'
                        AND li.total_cents > coalesce((SELECT sum(lc.total_cents) FROM club_invoices lc
                                                        WHERE lc.club_id = li.club_id
                                                          AND lc.corrects_id = li.id), 0))`;
}

/** What the document prints about the club. */
export interface InvoiceSupplier {
  name: string;
  eik: string;
  vatNumber: string | null;
  address: string;
  iban: string | null;
  defaultVatBp: InvoiceVatRate;
  /** The legal basis printed for a 0 % line of a VAT-registered club. */
  zeroVatBasis: string | null;
}

/** The club's details for an invoice — null while something required is missing. */
async function supplierOf(db: SqlRunner, clubId: string): Promise<InvoiceSupplier | null> {
  const row = (
    await db.execute(sql`
      SELECT c.legal_name, c.eik, ist.vat_number, ist.legal_address, ist.iban, ist.invoice_vat_bp,
             ist.zero_vat_basis
        FROM clubs c
        LEFT JOIN club_invoice_settings ist ON ist.club_id = c.id
       WHERE c.id = ${clubId}::uuid
    `)
  ).rows[0];
  const name = text(row?.legal_name);
  const eik = text(row?.eik);
  const address = text(row?.legal_address);
  if (!row || !name || !eik || !address) return null;
  return {
    name,
    eik,
    vatNumber: text(row.vat_number),
    address,
    iban: text(row.iban),
    defaultVatBp: rate(row.invoice_vat_bp) ?? 2000,
    zeroVatBasis: text(row.zero_vat_basis),
  };
}

/** How the money came, as the document says it: the method that brought most. */
function documentMethod(nets: { method: string; net: number }[]): InvoicePaymentMethod {
  const best = nets
    .filter((n) => n.net > 0)
    .sort((a, b) => b.net - a.net || a.method.localeCompare(b.method))[0];
  if (!best) return 'unpaid';
  const map: Record<string, InvoicePaymentMethod> = {
    cash: 'cash',
    card_desk: 'card',
    bank: 'bank',
    card_online: 'online',
    wallet: 'wallet',
    other: 'other',
  };
  return map[best.method] ?? 'other';
}

export interface InvoiceDraft {
  chargeId: string;
  memberId: string | null;
  memberName: string | null;
  supplier: InvoiceSupplier | null;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
  paymentMethod: InvoicePaymentMethod;
  taxEventOn: IsoDate;
  /** The charge's live invoice, when it already has one. */
  existingInvoiceId: string | null;
}

/**
 * Read a charge into what its invoice would say. `db` is the caller's
 * transaction when issuing, or the pool for the preview.
 */
async function draftFor(
  db: SqlRunner,
  actor: ClubActor,
  chargeId: string,
  today: IsoDate,
): Promise<InvoiceDraft | null> {
  const charge = (
    await db.execute(sql`
      SELECT ch.id, ch.label, ch.amount_cents, ch.member_id, m.display_name,
             to_char(ch.issued_on, 'YYYY-MM-DD') AS issued_on,
             (SELECT sa.id FROM club_sales sa
               WHERE sa.club_id = ch.club_id AND sa.charge_id = ch.id) AS sale_id,
             (SELECT to_char(min(p.received_on), 'YYYY-MM-DD') FROM club_payments p
               WHERE p.charge_id = ch.id AND p.kind = 'payment') AS paid_on,
             (SELECT i.id FROM club_invoices i
               WHERE i.club_id = ch.club_id AND i.charge_id = ch.id AND i.kind = 'invoice'
                 AND i.total_cents > coalesce((SELECT sum(c.total_cents) FROM club_invoices c
                                                WHERE c.club_id = i.club_id AND c.corrects_id = i.id), 0)
               LIMIT 1) AS invoice_id
        FROM club_charges ch
        LEFT JOIN club_members m ON m.club_id = ch.club_id AND m.id = ch.member_id
       WHERE ch.id = ${chargeId}::uuid AND ch.voided_at IS NULL
         -- Prepaid credit is invoiced when it is SPENT, where the VAT falls.
         AND ch.kind <> 'wallet'
         AND ${clubScope(actor, 'invoices.issue', 'ch')}
    `)
  ).rows[0];
  if (!charge) return null;
  const supplier = await supplierOf(db, actor.clubId);
  const saleId = text(charge.sale_id);
  const inputs: InvoiceLineInput[] = saleId
    ? (
        await db.execute(sql`
          SELECT sl.name, sl.quantity, sl.unit_price_cents, sl.discount_cents, sl.vat_rate_bp
            FROM club_sale_lines sl
           WHERE sl.club_id = ${actor.clubId}::uuid AND sl.sale_id = ${saleId}::uuid
           ORDER BY sl.line_no
        `)
      ).rows.map((row) => ({
        description: String(row.name),
        quantity: Number(row.quantity),
        unitPriceCents: Number(row.unit_price_cents),
        discountCents: Number(row.discount_cents),
        vatRateBp: rate(row.vat_rate_bp),
      }))
    : [
        {
          description: String(charge.label),
          quantity: 1,
          unitPriceCents: Number(charge.amount_cents),
          discountCents: 0,
          vatRateBp: null,
        },
      ];
  const lines = invoiceLines(inputs, {
    vatRegistered: Boolean(supplier?.vatNumber),
    defaultVatBp: supplier?.defaultVatBp ?? 2000,
  });
  const nets = (
    await db.execute(sql`
      SELECT p.method, sum(p.amount_cents)::int AS net FROM club_payments p
       WHERE p.club_id = ${actor.clubId}::uuid AND p.charge_id = ${chargeId}::uuid
       GROUP BY p.method
    `)
  ).rows.map((row) => ({ method: String(row.method), net: Number(row.net) }));
  // The tax event: the delivery (the day of the charge) or the first money,
  // whichever came first — an advance is taxed when it is paid — and never
  // after the day the document is issued.
  const paidOn = text(charge.paid_on);
  const issuedOn = String(charge.issued_on);
  const event = paidOn !== null && paidOn < issuedOn ? paidOn : issuedOn;
  return {
    chargeId,
    memberId: text(charge.member_id),
    memberName: text(charge.display_name),
    supplier,
    lines,
    totals: invoiceTotals(lines),
    paymentMethod: documentMethod(nets),
    taxEventOn: event > today ? today : event,
    existingInvoiceId: text(charge.invoice_id),
  };
}

/** The preview of a charge's invoice, for the office to check. */
export async function invoiceDraft(
  actor: ClubActor,
  chargeId: string,
  today: IsoDate = sofiaToday(),
): Promise<InvoiceDraft | null> {
  return draftFor(getDb(), actor, chargeId, today);
}

export interface InvoiceBuyer {
  kind: InvoiceBuyerKind;
  name: string;
  eik: string | null;
  vatNumber: string | null;
  address: string | null;
}

export type IssueResult = { ok: true; invoiceId: string } | { ok: false; error: string };

class Refused extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * The next document number, gapless: the counter row stays locked until
 * commit. `write` false for a credit note: correcting an issued document is
 * an obligation that does not lapse with the club's plan or payment.
 */
async function drawNumber(tx: SqlRunner, actor: ClubActor, write = true): Promise<number> {
  const number = Number(
    (
      await tx.execute(sql`
        INSERT INTO club_number_sequences (club_id, kind, last_value)
        SELECT ${actor.clubId}::uuid, 'invoice', 1
         WHERE ${clubActorMay(actor, 'invoices.issue', { write })}
        ON CONFLICT (club_id, kind) DO UPDATE
          SET last_value = club_number_sequences.last_value + 1
        RETURNING last_value
      `)
    ).rows[0]?.last_value,
  );
  if (!Number.isSafeInteger(number) || number < 1) throw new Refused('not_allowed');
  return number;
}

async function insertLines(
  tx: SqlRunner,
  actor: ClubActor,
  invoiceId: string,
  lines: readonly InvoiceLine[],
  write = true,
): Promise<void> {
  for (const [index, line] of lines.entries()) {
    await tx.execute(sql`
      INSERT INTO club_invoice_lines (club_id, invoice_id, line_no, description, quantity,
                                      unit_price_cents, discount_cents, vat_rate_bp, base_cents,
                                      vat_cents, total_cents)
      SELECT ${actor.clubId}::uuid, ${invoiceId}::uuid, ${index + 1},
             ${line.description.slice(0, 200)}, ${line.quantity}, ${line.unitPriceCents},
             ${line.discountCents}, ${line.vatRateBp}, ${line.baseCents}, ${line.vatCents},
             ${line.totalCents}
       WHERE ${clubActorMay(actor, 'invoices.issue', { write })}
    `);
  }
}

function invoiceErrorCode(error: unknown): string | null {
  const constraint = violatedConstraint(error);
  if (constraint === 'club_invoices_one_per_charge') return 'invoice_exists';
  if (constraint === 'club_invoices_credit_within_invoice') return 'already_credited';
  if (constraint === 'club_invoices_buyer_identified') return 'buyer_incomplete';
  if (constraint === 'club_invoices_charge_invoiceable') return 'not_allowed';
  if (constraint === 'club_invoices_chronology') return 'invoice_chronology';
  return null;
}

/**
 * Issue a charge's invoice to `buyer`. Refusals: not_allowed (no such charge
 * here, void, or the tier lacks invoices), invoice_details_missing (the
 * club's legal name, EIK or address), invoice_exists, buyer_incomplete.
 */
export async function issueInvoice(
  db: TransactionalDb,
  actor: ClubActor,
  input: { chargeId: string; buyer: InvoiceBuyer },
  today: IsoDate = sofiaToday(),
): Promise<IssueResult> {
  try {
    return await db.transaction(async (tx) => {
      const allowed = await tx.execute(sql`
        SELECT 1 WHERE ${clubActorMay(actor, 'invoices.issue', { write: true })}
                   AND ${clubFeatureSql(actor.clubId, 'invoices')}
      `);
      if (allowed.rows.length === 0) throw new Refused('not_allowed');
      // The charge before the counter (0050's order: charge → invoice
      // counter → invoice), as every money path takes the charge first.
      await tx.execute(sql`
        SELECT 1 FROM club_charges ch
         WHERE ch.id = ${input.chargeId}::uuid AND ${clubScope(actor, 'invoices.issue', 'ch')}
           FOR NO KEY UPDATE
      `);
      const draft = await draftFor(tx, actor, input.chargeId, today);
      if (!draft) throw new Refused('not_allowed');
      if (draft.existingInvoiceId) throw new Refused('invoice_exists');
      if (!draft.supplier) throw new Refused('invoice_details_missing');
      if (draft.totals.totalCents <= 0) throw new Refused('not_allowed');
      // A VAT-registered club states the legal basis of a 0 % line.
      const zeroLine = draft.lines.some((line) => line.vatRateBp === 0);
      if (zeroLine && draft.supplier.vatNumber && !draft.supplier.zeroVatBasis) {
        throw new Refused('zero_vat_basis_missing');
      }
      const number = await drawNumber(tx, actor);
      const { supplier, totals } = draft;
      const invoiceId = text(
        (
          await tx.execute(sql`
            INSERT INTO club_invoices (club_id, kind, number, issued_on, tax_event_on, charge_id,
                                       member_id, supplier_name, supplier_eik, supplier_vat_number,
                                       supplier_address, supplier_iban, buyer_kind, buyer_name,
                                       buyer_eik, buyer_vat_number, buyer_address, payment_method,
                                       zero_vat_basis, base_cents, vat_cents, total_cents,
                                       issued_by)
            SELECT ${actor.clubId}::uuid, 'invoice', ${number}, ${today}::date,
                   ${draft.taxEventOn}::date, ${input.chargeId}::uuid, ${draft.memberId}::uuid,
                   ${supplier.name}, ${supplier.eik}, ${supplier.vatNumber}, ${supplier.address},
                   ${supplier.iban}, ${input.buyer.kind}, ${input.buyer.name}, ${input.buyer.eik},
                   ${input.buyer.vatNumber}, ${input.buyer.address}, ${draft.paymentMethod},
                   ${zeroLine && supplier.vatNumber ? supplier.zeroVatBasis : null},
                   ${totals.baseCents}, ${totals.vatCents}, ${totals.totalCents}, ${actor.userId}
             WHERE ${clubActorMay(actor, 'invoices.issue', { write: true })}
            RETURNING id
          `)
        ).rows[0]?.id,
      );
      if (!invoiceId) throw new Refused('not_allowed');
      await insertLines(tx, actor, invoiceId, draft.lines);
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'invoice_issued',
        subjectMemberId: draft.memberId,
        detail: { invoiceId, number, totalCents: totals.totalCents },
      });
      return { ok: true, invoiceId } as const;
    });
  } catch (error: unknown) {
    if (error instanceof Refused) return { ok: false, error: error.code };
    const code = invoiceErrorCode(error);
    if (code) return { ok: false, error: code };
    throw error;
  }
}

/**
 * Cancel an invoice by a credit note for the whole of it: the same lines,
 * parties and method, a new number from the same series, and the reason.
 * A partly credited invoice is refused here (the database allows a partial
 * correction; the office's one action is the whole). Allowed on any tier and
 * while the club is read-only: correcting an issued document is an
 * obligation that outlives the plan.
 */
export async function issueCreditNote(
  db: TransactionalDb,
  actor: ClubActor,
  invoiceId: string,
  reason: string,
  today: IsoDate = sofiaToday(),
): Promise<IssueResult> {
  try {
    return await db.transaction(async (tx) => {
      const original = (
        await tx.execute(sql`
          SELECT i.id, i.member_id,
                 (SELECT coalesce(sum(c.total_cents), 0) FROM club_invoices c
                   WHERE c.club_id = i.club_id AND c.corrects_id = i.id) AS credited
            FROM club_invoices i
           WHERE i.id = ${invoiceId}::uuid AND i.kind = 'invoice'
             AND ${clubScope(actor, 'invoices.issue', 'i')}
        `)
      ).rows[0];
      if (!original) throw new Refused('not_allowed');
      if (Number(original.credited) > 0) throw new Refused('already_credited');
      const lines = (
        await tx.execute(sql`
          SELECT il.description, il.quantity, il.unit_price_cents, il.discount_cents,
                 il.vat_rate_bp, il.base_cents, il.vat_cents, il.total_cents
            FROM club_invoice_lines il
           WHERE il.invoice_id = ${invoiceId}::uuid AND ${clubScope(actor, 'invoices.issue', 'il')}
           ORDER BY il.line_no
        `)
      ).rows.map((row): InvoiceLine => ({
        description: String(row.description),
        quantity: Number(row.quantity),
        unitPriceCents: Number(row.unit_price_cents),
        discountCents: Number(row.discount_cents),
        vatRateBp: rate(row.vat_rate_bp),
        baseCents: Number(row.base_cents),
        vatCents: Number(row.vat_cents),
        totalCents: Number(row.total_cents),
      }));
      const number = await drawNumber(tx, actor, false);
      const creditId = text(
        (
          await tx.execute(sql`
            INSERT INTO club_invoices (club_id, kind, number, issued_on, tax_event_on, corrects_id,
                                       reason, charge_id, member_id, supplier_name, supplier_eik,
                                       supplier_vat_number, supplier_address, supplier_iban,
                                       buyer_kind, buyer_name, buyer_eik, buyer_vat_number,
                                       buyer_address, payment_method, zero_vat_basis, base_cents,
                                       vat_cents, total_cents, issued_by)
            SELECT i.club_id, 'credit_note', ${number}, ${today}::date, ${today}::date, i.id,
                   ${reason.slice(0, 200)}, i.charge_id, i.member_id, i.supplier_name,
                   i.supplier_eik, i.supplier_vat_number, i.supplier_address, i.supplier_iban,
                   i.buyer_kind, i.buyer_name, i.buyer_eik, i.buyer_vat_number, i.buyer_address,
                   i.payment_method, i.zero_vat_basis, i.base_cents, i.vat_cents, i.total_cents,
                   ${actor.userId}
              FROM club_invoices i
             WHERE i.id = ${invoiceId}::uuid AND ${clubScope(actor, 'invoices.issue', 'i')}
            RETURNING id
          `)
        ).rows[0]?.id,
      );
      if (!creditId) throw new Refused('not_allowed');
      await insertLines(tx, actor, creditId, lines, false);
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'credit_note_issued',
        subjectMemberId: text(original.member_id),
        detail: { invoiceId: creditId, corrects: invoiceId, number },
      });
      return { ok: true, invoiceId: creditId } as const;
    });
  } catch (error: unknown) {
    if (error instanceof Refused) return { ok: false, error: error.code };
    const code = invoiceErrorCode(error);
    if (code) return { ok: false, error: code };
    throw error;
  }
}

export interface InvoiceSummary {
  id: string;
  kind: 'invoice' | 'credit_note';
  number: number;
  issuedOn: IsoDate;
  buyerName: string;
  totalCents: number;
  /** For an invoice: what credit notes have taken back. */
  creditedCents: number;
}

/**
 * The club's documents, newest number first, a page at a time: `before` is
 * the number the next page starts below. invoices.issue.
 */
export async function clubInvoices(
  actor: ClubActor,
  options: { before?: number; limit?: number } = {},
): Promise<InvoiceSummary[]> {
  const result = await getDb().execute(sql`
    SELECT i.id, i.kind, i.number, i.issued_on, i.buyer_name, i.total_cents,
           (SELECT coalesce(sum(c.total_cents), 0)::int FROM club_invoices c
             WHERE c.club_id = i.club_id AND c.corrects_id = i.id) AS credited
      FROM club_invoices i
     WHERE ${clubScope(actor, 'invoices.issue', 'i')}
       AND ${options.before === undefined ? sql`true` : sql`i.number < ${options.before}`}
     ORDER BY i.number DESC
     LIMIT ${options.limit ?? 100}
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    kind: row.kind === 'credit_note' ? 'credit_note' : 'invoice',
    number: Number(row.number),
    issuedOn: day(row.issued_on),
    buyerName: String(row.buyer_name),
    totalCents: Number(row.total_cents),
    creditedCents: Number(row.credited ?? 0),
  }));
}

export interface InvoiceDocument extends InvoiceSummary {
  taxEventOn: IsoDate;
  reason: string | null;
  chargeId: string | null;
  memberId: string | null;
  supplier: Omit<InvoiceSupplier, 'defaultVatBp' | 'zeroVatBasis'>;
  /** The printed basis of the document's 0 % lines, if any. */
  zeroVatBasis: string | null;
  buyer: InvoiceBuyer;
  paymentMethod: InvoicePaymentMethod;
  baseCents: number;
  vatCents: number;
  issuedByName: string | null;
  lines: InvoiceLine[];
  /** The invoice a credit note corrects. */
  corrects: { id: string; number: number; issuedOn: IsoDate } | null;
  /** The credit notes that correct this invoice. */
  correctedBy: { id: string; number: number; issuedOn: IsoDate }[];
}

/** One document, as printed. invoices.issue. */
export async function invoiceById(
  actor: ClubActor,
  invoiceId: string,
): Promise<InvoiceDocument | null> {
  const row = (
    await getDb().execute(sql`
      SELECT i.*, (SELECT coalesce(sum(c.total_cents), 0)::int FROM club_invoices c
                    WHERE c.club_id = i.club_id AND c.corrects_id = i.id) AS credited,
             coalesce(nullif(btrim(s.display_name), ''), nullif(btrim(u.display_name), '')) AS issuer
        FROM club_invoices i
        LEFT JOIN club_staff s ON s.club_id = i.club_id AND s.user_id = i.issued_by
        LEFT JOIN users u ON u.id = i.issued_by
       WHERE i.id = ${invoiceId}::uuid AND ${clubScope(actor, 'invoices.issue', 'i')}
    `)
  ).rows[0];
  if (!row) return null;
  const correctsId = text(row.corrects_id);
  const [lines, related] = await Promise.all([
    getDb().execute(sql`
      SELECT il.description, il.quantity, il.unit_price_cents, il.discount_cents, il.vat_rate_bp,
             il.base_cents, il.vat_cents, il.total_cents
        FROM club_invoice_lines il
       WHERE il.invoice_id = ${invoiceId}::uuid AND ${clubScope(actor, 'invoices.issue', 'il')}
       ORDER BY il.line_no
    `),
    getDb().execute(sql`
      SELECT i.id, i.number, i.issued_on, i.kind
        FROM club_invoices i
       WHERE (i.corrects_id = ${invoiceId}::uuid
              OR ${correctsId === null ? sql`false` : sql`i.id = ${correctsId}::uuid`})
         AND ${clubScope(actor, 'invoices.issue', 'i')}
       ORDER BY i.number
    `),
  ]);
  const ref = (r: Record<string, unknown>) => ({
    id: String(r.id),
    number: Number(r.number),
    issuedOn: day(r.issued_on),
  });
  const corrected = related.rows.find((r) => r.kind === 'invoice');
  return {
    id: String(row.id),
    kind: row.kind === 'credit_note' ? 'credit_note' : 'invoice',
    number: Number(row.number),
    issuedOn: day(row.issued_on),
    taxEventOn: day(row.tax_event_on),
    reason: text(row.reason),
    chargeId: text(row.charge_id),
    memberId: text(row.member_id),
    buyerName: String(row.buyer_name),
    totalCents: Number(row.total_cents),
    baseCents: Number(row.base_cents),
    vatCents: Number(row.vat_cents),
    creditedCents: Number(row.credited ?? 0),
    supplier: {
      name: String(row.supplier_name),
      eik: String(row.supplier_eik),
      vatNumber: text(row.supplier_vat_number),
      address: String(row.supplier_address),
      iban: text(row.supplier_iban),
    },
    buyer: {
      kind: row.buyer_kind === 'company' ? 'company' : 'person',
      name: String(row.buyer_name),
      eik: text(row.buyer_eik),
      vatNumber: text(row.buyer_vat_number),
      address: text(row.buyer_address),
    },
    paymentMethod: String(row.payment_method) as InvoicePaymentMethod,
    zeroVatBasis: text(row.zero_vat_basis),
    issuedByName: text(row.issuer),
    lines: lines.rows.map((l) => ({
      description: String(l.description),
      quantity: Number(l.quantity),
      unitPriceCents: Number(l.unit_price_cents),
      discountCents: Number(l.discount_cents),
      vatRateBp: rate(l.vat_rate_bp),
      baseCents: Number(l.base_cents),
      vatCents: Number(l.vat_cents),
      totalCents: Number(l.total_cents),
    })),
    corrects: corrected ? ref(corrected) : null,
    correctedBy: related.rows.filter((r) => r.kind === 'credit_note').map(ref),
  };
}

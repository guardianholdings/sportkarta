/**
 * Invoices and credit notes (0050, wave B2) — the arithmetic, pure, so the
 * draft the office checks, the rows the database keeps and the printed
 * document can never disagree.
 *
 * THE RULES:
 *   - prices are GROSS, as the club charged them: a line's total is what the
 *     client paid for it, and its tax base and VAT are split out of it —
 *     base = round(total × 10000 / (10000 + rate)), VAT = total − base — so
 *     the parts always add up to the cent;
 *   - a club without a VAT number invoices without VAT: every line's base is
 *     its total and no rate is printed;
 *   - the document number is the club's gapless counter, printed as ten
 *     digits — one series for invoices and credit notes.
 */

/** The rates a Bulgarian club's sales carry, in basis points. */
export const INVOICE_VAT_RATES = [0, 900, 2000] as const;
export type InvoiceVatRate = (typeof INVOICE_VAT_RATES)[number];

export const INVOICE_BUYER_KINDS = ['person', 'company'] as const;
export type InvoiceBuyerKind = (typeof INVOICE_BUYER_KINDS)[number];

/** club_invoices_payment_known (0050). */
export const INVOICE_PAYMENT_METHODS = [
  'cash',
  'card',
  'bank',
  'online',
  'wallet',
  'other',
  'unpaid',
] as const;
export type InvoicePaymentMethod = (typeof INVOICE_PAYMENT_METHODS)[number];

export interface InvoiceLineInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  /** The line's own rate (a product's); null takes the club's default. */
  vatRateBp: InvoiceVatRate | null;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  /** Null when the supplier is not VAT-registered. */
  vatRateBp: InvoiceVatRate | null;
  baseCents: number;
  vatCents: number;
  totalCents: number;
}

/** Split a gross amount into its tax base and VAT; no rate: no VAT. */
export function splitVat(
  totalCents: number,
  rateBp: InvoiceVatRate | null,
): { baseCents: number; vatCents: number } {
  if (rateBp === null || rateBp === 0) return { baseCents: totalCents, vatCents: 0 };
  const baseCents = Math.round((totalCents * 10_000) / (10_000 + rateBp));
  return { baseCents, vatCents: totalCents - baseCents };
}

/**
 * The document's lines: each total is gross less its discount, split by the
 * line's rate (or the club's default) — or not at all for a supplier who is
 * not VAT-registered.
 */
export function invoiceLines(
  inputs: readonly InvoiceLineInput[],
  supplier: { vatRegistered: boolean; defaultVatBp: InvoiceVatRate },
): InvoiceLine[] {
  return inputs.map((input) => {
    const totalCents = input.unitPriceCents * input.quantity - input.discountCents;
    const rate = supplier.vatRegistered ? (input.vatRateBp ?? supplier.defaultVatBp) : null;
    return {
      description: input.description,
      quantity: input.quantity,
      unitPriceCents: input.unitPriceCents,
      discountCents: input.discountCents,
      vatRateBp: rate,
      totalCents,
      ...splitVat(totalCents, rate),
    };
  });
}

export interface InvoiceTotals {
  baseCents: number;
  vatCents: number;
  totalCents: number;
  /** Tax base and VAT per rate, highest rate first — what the document lists. */
  byRate: { vatRateBp: InvoiceVatRate | null; baseCents: number; vatCents: number }[];
}

export function invoiceTotals(lines: readonly InvoiceLine[]): InvoiceTotals {
  const byRate = new Map<InvoiceVatRate | null, { baseCents: number; vatCents: number }>();
  for (const line of lines) {
    const sum = byRate.get(line.vatRateBp) ?? { baseCents: 0, vatCents: 0 };
    sum.baseCents += line.baseCents;
    sum.vatCents += line.vatCents;
    byRate.set(line.vatRateBp, sum);
  }
  return {
    baseCents: lines.reduce((sum, line) => sum + line.baseCents, 0),
    vatCents: lines.reduce((sum, line) => sum + line.vatCents, 0),
    totalCents: lines.reduce((sum, line) => sum + line.totalCents, 0),
    byRate: [...byRate]
      .map(([vatRateBp, sum]) => ({ vatRateBp, ...sum }))
      .sort((a, b) => (b.vatRateBp ?? -1) - (a.vatRateBp ?? -1)),
  };
}

/** The printed number: ten digits, zero-padded. */
export function formatInvoiceNumber(number: number): string {
  return String(number).padStart(10, '0');
}

/** A Bulgarian EIK (БУЛСТАТ): 9 or 13 digits. */
export function isEik(value: string): boolean {
  return /^([0-9]{9}|[0-9]{13})$/.test(value);
}

/** A Bulgarian VAT number: BG and the EIK (or the 10-digit personal one). */
export function isBgVatNumber(value: string): boolean {
  return /^BG[0-9]{9,10}$/.test(value);
}

/** Any EU VAT number's shape: two letters, then 2–13 letters or digits. */
export function isVatNumber(value: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{2,13}$/.test(value);
}

/**
 * An IBAN, by its shape and its ISO 13616 check digits (mod 97 = 1), so a
 * mistyped account is refused before it is printed on every invoice.
 */
export function isIban(value: string): boolean {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(value)) return false;
  const moved = value.slice(4) + value.slice(0, 4);
  let remainder = 0;
  for (const char of moved) {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** Spaces and dashes out, upper case: how an IBAN or a VAT number is typed. */
export function compactCode(value: string): string {
  return value.replace(/[\s-]+/g, '').toUpperCase();
}

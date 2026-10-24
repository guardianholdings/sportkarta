/**
 * Euro amounts for the club module — integer CENTS everywhere, text only at
 * the edges (0041: prices and payments are `integer` euro cents; Bulgaria's
 * dual BGN/EUR display ended 2026-08-08, so there is one currency).
 *
 * Parsing accepts what a Bulgarian desk types: "50", "50,5", "50,50",
 * "1 200,00", "1200.00", with or without "€" or "EUR". It refuses anything
 * ambiguous rather than guessing — "1.200" could be 1,2 € or 1 200 € — and
 * anything with more than two decimals, a sign, or above the database bound.
 */

/** The bound every amount CHECK in 0041 uses (100 000 €). */
export const MAX_AMOUNT_CENTS = 10_000_000;

export function parseEuroCents(input: string): number | null {
  let text = input
    .trim()
    .replace(/€|eur$|^eur/gi, '')
    .trim();
  // Thousands separators: ordinary, no-break and narrow no-break spaces.
  text = text.replace(/[\s  ]/g, '');
  if (text === '') return null;
  // One decimal separator at most, of either kind, followed by 1–2 digits.
  const match = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = match[2] ?? '';
  // "1.200" (a dot then exactly three digits) is refused by the regex above,
  // since the fraction allows two digits at most — deliberately.
  const cents = whole * 100 + (fraction === '' ? 0 : Number(fraction.padEnd(2, '0')));
  if (!Number.isSafeInteger(cents) || cents > MAX_AMOUNT_CENTS) return null;
  return cents;
}

/** "50,00 €" in bg, "€50.00" in en — Intl, so the locale decides the shape. */
export function formatEuro(cents: number, locale: string): string {
  return new Intl.NumberFormat(locale === 'en' ? 'en-IE' : 'bg-BG', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/** The editable form of an amount: "50,00" in bg, "50.00" in en. */
export function euroInputValue(cents: number, locale: string): string {
  const text = (cents / 100).toFixed(2);
  return locale === 'en' ? text : text.replace('.', ',');
}

import type { InvoicePaymentMethod } from './invoices.js';

/**
 * The words ON an invoice or credit note (0050) — a Bulgarian accounting
 * document, which reads the same whatever language the office uses: the
 * Accounting Act and ЗДДС ask for it in Bulgarian. So these field names are
 * data, kept here like the ministry annex's (lib/src/reports), not UI copy in
 * messages/*.json; the office's own buttons and hints around the document
 * are translated as usual.
 */
export const INVOICE_DOCUMENT = {
  invoice: 'ФАКТУРА',
  creditNote: 'КРЕДИТНО ИЗВЕСТИЕ',
  original: 'Оригинал',
  number: '№',
  issuedOn: 'Дата на издаване',
  taxEventOn: 'Дата на данъчното събитие',
  corrects: 'Към фактура',
  of: 'от',
  reason: 'Основание',
  /** The reason on the credit note a pay-out of invoiced credit writes. */
  creditPaidOut: 'Върнат предплатен кредит',
  supplier: 'Доставчик',
  buyer: 'Получател',
  eik: 'ЕИК',
  vatNumber: 'ДДС №',
  address: 'Адрес',
  iban: 'IBAN',
  lineNo: '№',
  description: 'Наименование на стоката или услугата',
  quantity: 'Кол.',
  unitPrice: 'Ед. цена',
  unitPriceNet: 'Ед. цена без ДДС',
  amountNet: 'Стойност без ДДС',
  rate: 'Ставка',
  discounted: 'с отстъпка',
  discount: 'Отстъпка',
  amount: 'Стойност',
  taxBase: 'Данъчна основа',
  totalBase: 'Общо данъчна основа',
  totalVat: 'Общо ДДС',
  vatAt: 'ДДС',
  total: 'Сума за плащане',
  creditTotal: 'Сума за възстановяване',
  paymentMethod: 'Начин на плащане',
  currency: 'Валута: EUR',
  noVat: 'Основание за неначисляване на ДДС: чл. 113, ал. 9 от ЗДДС',
  zeroBasis: 'Основание за ставка 0 %',
  issuedBy: 'Съставил',
  dateSuffix: 'г.',
  methods: {
    cash: 'В брой',
    card: 'С карта',
    bank: 'По банков път',
    online: 'С карта онлайн',
    wallet: 'С предплатен кредит',
    other: 'Друг',
    unpaid: 'Предстои плащане',
  } satisfies Record<InvoicePaymentMethod, string>,
} as const;

/** dd.mm.yyyy г. — how a Bulgarian document prints a date. */
export function documentDate(isoDate: string): string {
  const [year, month, day] = isoDate.slice(0, 10).split('-');
  return `${day ?? ''}.${month ?? ''}.${year ?? ''} ${INVOICE_DOCUMENT.dateSuffix}`;
}

/** A rate in basis points as the document prints it: «20 %». */
export function documentRate(rateBp: number): string {
  return `${String(rateBp / 100).replace('.', ',')} %`;
}

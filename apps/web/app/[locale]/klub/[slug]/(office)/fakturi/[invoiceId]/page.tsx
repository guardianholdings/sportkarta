import {
  documentDate,
  documentRate,
  formatEuro,
  formatInvoiceNumber,
  INVOICE_DOCUMENT,
  invoiceTotals,
} from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { PrintButton } from '@/components/clubs/print-button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Link } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { isUuid } from '@/lib/clubs/input';
import { invoiceById, invoicesOwingCredit } from '@/lib/clubs/invoices';
import { formErrorText } from '@/lib/clubs/form-error';

import { creditNoteAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * One invoice or credit note (0050), as the document reads — in Bulgarian
 * whatever the office's language (INVOICE_DOCUMENT), amounts in EUR — and
 * printable («Save as PDF» in the browser; no server PDF). The office's own
 * controls around it are translated and hidden in print. What is left of an
 * invoice — all of it, or the rest after a pay-out's partial credit note —
 * can be cancelled by a credit note.
 */
export default async function InvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string; invoiceId: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug, invoiceId } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'invoices.issue');
  if (!isUuid(invoiceId)) notFound();
  const invoice = await invoiceById(actor, invoiceId);
  if (!invoice) notFound();
  const [t, messages, owing] = await Promise.all([
    getTranslations('ClubInvoices'),
    clubFormMessages(),
    invoice.kind === 'invoice' ? invoicesOwingCredit(actor, invoice.id) : Promise.resolve([]),
  ]);
  const left = invoice.totalCents - invoice.creditedCents;
  // Money given back that no credit note covers: a one-line invoice is
  // corrected by exactly that much; any other, as a whole.
  const uncovered = Math.min(owing[0]?.uncoveredCents ?? 0, left);
  const partAmount = uncovered > 0 && invoice.lines.length === 1 ? uncovered : null;
  const { rezultat } = await searchParams;
  const doc = INVOICE_DOCUMENT;
  // The document's amounts read the same in any office language.
  const euro = (cents: number) => formatEuro(cents, 'bg');
  const credit = invoice.kind === 'credit_note';
  const vat = invoice.supplier.vatNumber !== null;
  const totals = invoiceTotals(invoice.lines);
  const netUnit = new Intl.NumberFormat('bg-BG', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  });
  const good = rezultat === 'issued' || rezultat === 'credited';
  const outcome = !rezultat
    ? null
    : good
      ? t(`outcome.${rezultat}`)
      : formErrorText(messages, rezultat);
  const party = (
    title: string,
    p: {
      name: string;
      eik: string | null;
      vatNumber: string | null;
      address: string | null;
      iban?: string | null;
    },
  ) => (
    <div className="space-y-0.5">
      <p className="text-caption font-semibold uppercase tracking-wide text-text-muted">{title}</p>
      <p className="font-semibold text-ink">{p.name}</p>
      {p.eik && (
        <p>
          {doc.eik}: {p.eik}
        </p>
      )}
      {p.vatNumber && (
        <p>
          {doc.vatNumber}: {p.vatNumber}
        </p>
      )}
      {p.address && (
        <p>
          {doc.address}: {p.address}
        </p>
      )}
      {p.iban && (
        <p>
          {doc.iban}: {p.iban}
        </p>
      )}
    </div>
  );

  return (
    <main className="mx-auto max-w-3xl space-y-4">
      <Link
        href={`/klub/${slug}/fakturi`}
        className="text-body-sm font-semibold text-link hover:text-link-hover print:hidden"
      >
        ← {t('title')}
      </Link>
      {outcome && (
        <p
          role="status"
          className={`rounded-card border p-3 text-body-sm text-ink print:hidden ${
            good ? 'border-success-border bg-success-bg' : 'border-danger-border bg-danger-bg'
          }`}
        >
          {outcome}
        </p>
      )}
      <article
        lang="bg"
        className="space-y-4 rounded-card border border-line bg-surface p-5 text-body-sm text-ink shadow-sm print:border-0 print:p-0 print:shadow-none"
      >
        <header className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-h3 font-extrabold tracking-tight">
              {credit ? doc.creditNote : doc.invoice}
            </h1>
            <p className="font-mono tabular-nums">
              {doc.number} {formatInvoiceNumber(invoice.number)}
            </p>
          </div>
          <div className="text-right">
            <p className="font-semibold">{doc.original}</p>
            <p>
              {doc.issuedOn}: {documentDate(invoice.issuedOn)}
            </p>
            <p>
              {doc.taxEventOn}: {documentDate(invoice.taxEventOn)}
            </p>
          </div>
        </header>
        {credit && invoice.corrects && (
          <div className="space-y-0.5">
            <p>
              {doc.corrects} {doc.number} {formatInvoiceNumber(invoice.corrects.number)} {doc.of}{' '}
              {documentDate(invoice.corrects.issuedOn)}
            </p>
            <p>
              {doc.reason}: {invoice.reason}
            </p>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {party(doc.supplier, invoice.supplier)}
          {party(doc.buyer, invoice.buyer)}
        </div>
        {vat ? (
          // A VAT-registered supplier (ЗДДС чл. 114): each line's unit price
          // and value WITHOUT VAT and its rate, then the tax base and VAT per
          // rate. Prices are gross as charged, so the net unit price is the
          // line's base over its quantity — shown to the tenth of a cent
          // where it does not divide evenly.
          <table className="w-full text-body-sm">
            <thead>
              <tr className="border-b border-line-strong text-left text-caption text-text-muted">
                <th className="py-1 pr-2 font-semibold">{doc.lineNo}</th>
                <th className="py-1 pr-2 font-semibold">{doc.description}</th>
                <th className="py-1 pr-2 text-right font-semibold">{doc.quantity}</th>
                <th className="py-1 pr-2 text-right font-semibold">{doc.unitPriceNet}</th>
                <th className="py-1 pr-2 text-right font-semibold">{doc.rate}</th>
                <th className="py-1 text-right font-semibold">{doc.amountNet}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {invoice.lines.map((line, i) => (
                <tr key={i}>
                  <td className="py-1.5 pr-2 tabular-nums">{i + 1}</td>
                  <td className="py-1.5 pr-2">
                    {line.description}
                    {line.discountCents > 0 ? ` (${doc.discounted})` : ''}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{line.quantity}</td>
                  <td className="py-1.5 pr-2 text-right font-mono tabular-nums">
                    {netUnit.format(line.baseCents / line.quantity / 100)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {line.vatRateBp === null ? '—' : documentRate(line.vatRateBp)}
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums">
                    {euro(line.baseCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-body-sm">
            <thead>
              <tr className="border-b border-line-strong text-left text-caption text-text-muted">
                <th className="py-1 pr-2 font-semibold">{doc.lineNo}</th>
                <th className="py-1 pr-2 font-semibold">{doc.description}</th>
                <th className="py-1 pr-2 text-right font-semibold">{doc.quantity}</th>
                <th className="py-1 pr-2 text-right font-semibold">{doc.unitPrice}</th>
                <th className="py-1 pr-2 text-right font-semibold">{doc.discount}</th>
                <th className="py-1 text-right font-semibold">{doc.amount}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {invoice.lines.map((line, i) => (
                <tr key={i}>
                  <td className="py-1.5 pr-2 tabular-nums">{i + 1}</td>
                  <td className="py-1.5 pr-2">{line.description}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{line.quantity}</td>
                  <td className="py-1.5 pr-2 text-right font-mono tabular-nums">
                    {euro(line.unitPriceCents)}
                  </td>
                  <td className="py-1.5 pr-2 text-right font-mono tabular-nums">
                    {line.discountCents > 0 ? euro(line.discountCents) : '—'}
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums">
                    {euro(line.totalCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <dl className="ml-auto max-w-sm space-y-1">
          {vat &&
            totals.byRate.map((group) => (
              <div key={String(group.vatRateBp)} className="space-y-1">
                <div className="flex justify-between gap-4">
                  <dt>
                    {doc.taxBase} {group.vatRateBp === null ? '' : documentRate(group.vatRateBp)}
                  </dt>
                  <dd className="font-mono tabular-nums">{euro(group.baseCents)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>
                    {doc.vatAt} {group.vatRateBp === null ? '' : documentRate(group.vatRateBp)}
                  </dt>
                  <dd className="font-mono tabular-nums">{euro(group.vatCents)}</dd>
                </div>
              </div>
            ))}
          <div className="flex justify-between gap-4 border-t border-line pt-1">
            <dt>{vat ? doc.totalBase : doc.taxBase}</dt>
            <dd className="font-mono tabular-nums">{euro(invoice.baseCents)}</dd>
          </div>
          {vat && (
            <div className="flex justify-between gap-4">
              <dt>{doc.totalVat}</dt>
              <dd className="font-mono tabular-nums">{euro(invoice.vatCents)}</dd>
            </div>
          )}
          <div className="flex justify-between gap-4 border-t border-line pt-1 font-bold">
            <dt>{credit ? doc.creditTotal : doc.total}</dt>
            <dd className="font-mono tabular-nums">{euro(invoice.totalCents)}</dd>
          </div>
        </dl>
        <div className="space-y-0.5">
          <p>
            {doc.paymentMethod}: {doc.methods[invoice.paymentMethod]}
          </p>
          <p>{doc.currency}</p>
          {!vat && <p>{doc.noVat}</p>}
          {vat && invoice.zeroVatBasis && (
            <p>
              {doc.zeroBasis}: {invoice.zeroVatBasis}
            </p>
          )}
          {invoice.issuedByName && (
            <p>
              {doc.issuedBy}: {invoice.issuedByName}
            </p>
          )}
        </div>
      </article>
      <div className="flex flex-wrap items-start gap-2 print:hidden">
        <PrintButton
          label={t('print')}
          className="inline-flex min-h-11 items-center gap-2 rounded-pill border border-line-strong px-4 text-body-sm font-semibold text-ink hover:bg-surface-2 [&_svg]:size-4"
        />
        {invoice.correctedBy.map((note) => (
          <Link
            key={note.id}
            href={`/klub/${slug}/fakturi/${note.id}`}
            className="inline-flex min-h-11 items-center rounded-pill border border-line-strong px-4 text-body-sm font-semibold text-ink hover:bg-surface-2"
          >
            {t('creditNoteLink', { number: formatInvoiceNumber(note.number) })}
          </Link>
        ))}
      </div>
      {!credit && invoice.creditedCents < invoice.totalCents && (
        <form
          action={creditNoteAction}
          className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-sm print:hidden"
        >
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="invoiceId" value={invoice.id} />
          {partAmount !== null && <input type="hidden" name="amount" value={partAmount} />}
          <h2 className="text-h4 font-bold text-ink">{t('creditTitle')}</h2>
          <p className="text-caption text-text-muted">
            {partAmount !== null
              ? t('creditHintReturned', { amount: formatEuro(partAmount, locale) })
              : t('creditHint', { amount: formatEuro(left, locale) })}
          </p>
          <label className="block text-body-sm font-semibold text-ink">
            {t('creditReason')}
            <Input name="reason" required maxLength={200} className="mt-1" />
          </label>
          <ConfirmButton
            message={t('creditConfirm', { amount: formatEuro(partAmount ?? left, locale) })}
            className="inline-flex min-h-11 items-center rounded-pill border border-danger-border px-4 text-body-sm font-semibold text-danger hover:bg-danger-bg"
          >
            {t('creditIssue')}
          </ConfirmButton>
        </form>
      )}
    </main>
  );
}

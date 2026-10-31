import {
  clubHasFeature,
  formatEuro,
  formatInvoiceNumber,
  lowestTierWith,
} from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { featureOn } from '@/lib/clubs/features';
import { clubInvoices, invoicesOwingCredit } from '@/lib/clubs/invoices';
import { formatDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * The club's invoices and credit notes (0050), newest number first. An
 * invoice is issued from a charge — on the client's card or a sale's receipt.
 */
const PAGE = 100;

export default async function ClubInvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ pred?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor, club } = await requireClubStaff(slug, 'invoices.issue');
  const [t, tClub] = await Promise.all([getTranslations('ClubInvoices'), getTranslations('Club')]);

  // A page at a time, newest number first; `pred` is where the page starts below.
  const { pred } = await searchParams;
  const before = /^[1-9][0-9]{0,9}$/.test(pred ?? '') ? Number(pred) : undefined;
  const [invoices, owing] = await Promise.all([
    clubInvoices(actor, { before, limit: PAGE }),
    invoicesOwingCredit(actor),
  ]);
  // Without invoices on the plan (or the switch), no new ones are issued —
  // but documents already issued stay readable and correctable.
  const off = !featureOn(club, 'invoices');
  const offNote = clubHasFeature(club.tier, 'invoices')
    ? t('switchedOff')
    : t('upsell', { tier: tClub(`tier.${lowestTierWith('invoices')}`) });
  if (off && invoices.length === 0 && before === undefined) {
    return (
      <main className="space-y-4">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="max-w-prose text-body-sm text-ink-soft">{offNote}</p>
      </main>
    );
  }
  const last = invoices.at(-1);
  return (
    <main className="space-y-5">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1 max-w-prose text-body-sm text-ink-soft">{off ? offNote : t('intro')}</p>
        <p className="mt-1 max-w-prose text-caption text-text-muted">
          {t('detailsHint')}{' '}
          <Link
            href={`/klub/${slug}/nastroyki#fakturi`}
            className="font-semibold text-link hover:text-link-hover"
          >
            {t('detailsLink')}
          </Link>
        </p>
      </div>
      {owing.length > 0 && (
        <section
          aria-labelledby="owing-h"
          className="space-y-2 rounded-card border border-warning-border bg-warning-bg p-4"
        >
          <h2 id="owing-h" className="text-h4 font-bold text-ink">
            {t('owing.title')}
          </h2>
          <p className="max-w-prose text-body-sm text-ink">{t('owing.hint')}</p>
          <ul className="space-y-1">
            {owing.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/klub/${slug}/fakturi/${row.id}`}
                  className="text-body-sm font-semibold text-link hover:text-link-hover"
                >
                  {t('owing.item', {
                    number: formatInvoiceNumber(row.number),
                    buyer: row.buyerName,
                    amount: formatEuro(row.uncoveredCents, locale),
                  })}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
        {invoices.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('none')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {invoices.map((invoice) => (
              <li key={invoice.id}>
                <Link
                  href={`/klub/${slug}/fakturi/${invoice.id}`}
                  className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 py-2 text-body-sm hover:bg-surface-2"
                >
                  <span className="font-mono tabular-nums text-ink">
                    {formatInvoiceNumber(invoice.number)}
                  </span>
                  <span className="text-caption font-semibold text-ink-soft">
                    {t(`kind.${invoice.kind}`)}
                  </span>
                  <span className="text-caption text-text-muted">
                    {formatDate(invoice.issuedOn, locale)}
                  </span>
                  <span className="min-w-0 flex-1 text-ink">{invoice.buyerName}</span>
                  <span className="font-mono tabular-nums text-ink">
                    {invoice.kind === 'credit_note' ? '−' : ''}
                    {formatEuro(invoice.totalCents, locale)}
                  </span>
                  {invoice.kind === 'invoice' && invoice.creditedCents > 0 && (
                    <span className="text-caption font-semibold text-danger">
                      {invoice.creditedCents >= invoice.totalCents
                        ? t('credited')
                        : t('partlyCredited', {
                            amount: formatEuro(invoice.creditedCents, locale),
                          })}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {invoices.length === PAGE && last && (
          <Link
            href={{ pathname: `/klub/${slug}/fakturi`, query: { pred: String(last.number) } }}
            className="mt-3 inline-block text-body-sm font-semibold text-link hover:text-link-hover"
          >
            {t('older')}
          </Link>
        )}
      </section>
    </main>
  );
}

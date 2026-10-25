import { formatEuro } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { PrintButton } from '@/components/clubs/print-button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Link } from '@/i18n/navigation';
import { actorCan, clubName, requireClubStaff } from '@/lib/clubs/club-session';
import { isUuid } from '@/lib/clubs/input';
import { saleById } from '@/lib/clubs/shop';
import { formatDateTime } from '@/lib/format';

import { reverseSaleAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * A till sale's receipt (0049): what was sold, the offer, how it was paid —
 * printable, and marked «Не е фискален бон». Owner and manager may reverse it.
 */
export default async function ClubSalePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string; saleId: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug, saleId } = await params;
  setRequestLocale(locale);
  const { actor, club } = await requireClubStaff(slug, 'shop.sell');
  if (!isUuid(saleId)) notFound();
  const sale = await saleById(actor, saleId);
  if (!sale) notFound();
  const [t, tClub] = await Promise.all([getTranslations('ClubShop'), getTranslations('Club')]);
  const { rezultat } = await searchParams;
  const canReverse = actorCan(actor, 'charges.void') && !sale.reversed;
  const methodName = (method: string) =>
    tClub.has(`method.${method}`) ? tClub(`method.${method}`) : method;

  return (
    <main className="mx-auto max-w-lg space-y-4">
      <Link
        href={`/klub/${slug}/prodazhbi`}
        className="text-body-sm font-semibold text-link hover:text-link-hover print:hidden"
      >
        ← {t('salesTitle')}
      </Link>
      {rezultat && t.has(`outcome.${rezultat}`) && (
        <p
          role="status"
          className={`rounded-card border p-3 text-body-sm text-ink print:hidden ${
            rezultat === 'recorded' || rezultat === 'reversed'
              ? 'border-success-border bg-success-bg'
              : 'border-danger-border bg-danger-bg'
          }`}
        >
          {t(`outcome.${rezultat}`)}
        </p>
      )}
      <article className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm print:border-0 print:shadow-none">
        <header className="space-y-0.5">
          <p className="text-caption text-text-muted">{clubName(club, locale)}</p>
          <h1 className="text-h3 font-extrabold text-ink">
            {t('receiptTitle', { number: sale.number })}
          </h1>
          <p className="text-caption text-text-muted">
            {formatDateTime(sale.soldAt, locale)} · {sale.memberName ?? t('walkIn')}
          </p>
          {sale.reversed && (
            <p className="text-body-sm font-semibold text-danger">{t('reversedBadge')}</p>
          )}
        </header>
        <table className="w-full text-body-sm">
          <tbody className="divide-y divide-line">
            {sale.lines.map((line, i) => (
              <tr key={i}>
                <td className="py-1.5 text-ink">
                  {line.name}
                  <span className="block text-caption text-text-muted">
                    {line.quantity} × {formatEuro(line.unitPriceCents, locale)}
                    {line.discountCents > 0 ? ` − ${formatEuro(line.discountCents, locale)}` : ''}
                  </span>
                </td>
                <td className="py-1.5 text-right font-mono tabular-nums text-ink">
                  {formatEuro(line.totalCents, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sale.discountCents > 0 && (
          <p className="flex justify-between text-body-sm text-ink-soft">
            <span>
              {sale.promotionName ? t('offerNamed', { name: sale.promotionName }) : t('offer')}
            </span>
            <span className="font-mono tabular-nums">
              −{formatEuro(sale.discountCents, locale)}
            </span>
          </p>
        )}
        <p className="flex justify-between text-body font-bold text-ink">
          <span>{t('total')}</span>
          <span className="font-mono tabular-nums">{formatEuro(sale.totalCents, locale)}</span>
        </p>
        <p className="text-caption text-text-muted">
          {sale.payments.length === 0
            ? sale.totalCents === 0
              ? t('free')
              : t('onAccountNote')
            : sale.payments
                .map(
                  (p) =>
                    `${methodName(p.method)} ${formatEuro(p.amountCents, locale)}` +
                    (p.refundedCents > 0
                      ? ` · ${t('refunded', { amount: formatEuro(p.refundedCents, locale) })}`
                      : ''),
                )
                .join(' · ')}
        </p>
        <p className="border-t border-line pt-2 text-caption font-semibold text-ink">
          {t('notFiscal')}
        </p>
      </article>
      <div className="flex flex-wrap gap-2 print:hidden">
        <PrintButton
          label={t('print')}
          className="inline-flex min-h-11 items-center gap-2 rounded-pill border border-line-strong px-4 text-body-sm font-semibold text-ink hover:bg-surface-2 [&_svg]:size-4"
        />
        <Link
          href={`/klub/${slug}/prodazhbi/nova`}
          className="inline-flex min-h-11 items-center rounded-pill bg-brand px-5 text-body-sm font-semibold text-on-brand hover:bg-brand-hover"
        >
          {t('newSale')}
        </Link>
        {canReverse && (
          <form action={reverseSaleAction}>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="saleId" value={sale.id} />
            <ConfirmButton
              message={t('reverseConfirm')}
              className="inline-flex min-h-11 items-center rounded-pill border border-danger-border px-4 text-body-sm font-semibold text-danger hover:bg-danger-bg"
            >
              {t('reverse')}
            </ConfirmButton>
          </form>
        )}
      </div>
    </main>
  );
}

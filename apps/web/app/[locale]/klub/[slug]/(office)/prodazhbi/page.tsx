import { clubHasFeature, formatEuro, lowestTierWith } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { featureOn } from '@/lib/clubs/features';
import { recentSales } from '@/lib/clubs/shop';
import { formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** The till's recent sales (0049) — each opens its receipt. */
export default async function ClubSalesPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor, club } = await requireClubStaff(slug, 'shop.sell');
  const [t, tClub] = await Promise.all([getTranslations('ClubShop'), getTranslations('Club')]);

  if (!featureOn(club, 'shop')) {
    return (
      <main className="space-y-4">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('salesTitle')}</h1>
        <p className="max-w-prose text-body-sm text-ink-soft">
          {clubHasFeature(club.tier, 'shop')
            ? t('switchedOff')
            : t('upsell', { tier: tClub(`tier.${lowestTierWith('shop')}`) })}
        </p>
      </main>
    );
  }

  const sales = await recentSales(actor);
  return (
    <main className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('salesTitle')}</h1>
          <p className="mt-1 max-w-prose text-body-sm text-ink-soft">{t('salesIntro')}</p>
        </div>
        <Link
          href={`/klub/${slug}/prodazhbi/nova`}
          className="inline-flex min-h-11 items-center rounded-pill bg-brand px-5 text-body-sm font-semibold text-on-brand hover:bg-brand-hover"
        >
          {t('newSale')}
        </Link>
      </div>
      <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
        {sales.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('noSales')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {sales.map((sale) => (
              <li key={sale.id}>
                <Link
                  href={`/klub/${slug}/prodazhbi/${sale.id}`}
                  className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 py-2 text-body-sm hover:bg-surface-2"
                >
                  <span className="font-mono tabular-nums text-ink">
                    {t('number', { number: sale.number })}
                  </span>
                  <span className="text-caption text-text-muted">
                    {formatDateTime(sale.soldAt, locale)}
                  </span>
                  <span className="min-w-0 flex-1 text-ink">{sale.memberName ?? t('walkIn')}</span>
                  <span className="font-mono tabular-nums text-ink">
                    {formatEuro(sale.totalCents, locale)}
                  </span>
                  <span className="text-caption font-semibold text-ink-soft">
                    {sale.reversed ? t('reversedBadge') : t(`saleStatus.${sale.status}`)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

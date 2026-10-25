import { euroInputValue, formatEuro, sofiaToday } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { SaleForm } from '@/components/clubs/sales-forms';
import { Link } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { featureOn } from '@/lib/clubs/features';
import { clubFormMessages, saleFormLabels } from '@/lib/clubs/form-labels';
import { isUuid } from '@/lib/clubs/input';
import { memberChoices } from '@/lib/clubs/members';
import { listPlans } from '@/lib/clubs/sales';

import { previewSaleAction, sellAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function SalePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ chlen?: string; plan?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor, club } = await requireClubStaff(slug, 'sales.manage');
  const query = await searchParams;
  const [t, tClub, labels, messages, members, plans] = await Promise.all([
    getTranslations('ClubSales'),
    getTranslations('Club'),
    saleFormLabels(),
    clubFormMessages(),
    memberChoices(actor),
    listPlans(actor),
  ]);
  return (
    <main className="mx-auto max-w-2xl space-y-4">
      <Link
        href={`/klub/${slug}/abonamenti`}
        className="text-body-sm font-semibold text-link hover:text-link-hover"
      >
        ← {t('plansTitle')}
      </Link>
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('sale.title')}</h1>
      {plans.length === 0 ? (
        <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-body-sm text-text-muted">
          {t('noPlans')}
        </p>
      ) : (
        <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
          <SaleForm
            action={sellAction}
            preview={previewSaleAction}
            locale={locale}
            slug={slug}
            offers={featureOn(club, 'promotions')}
            labels={labels}
            messages={messages}
            today={sofiaToday()}
            members={members.map((m) => ({
              id: m.id,
              label: m.isMinor ? `${m.displayName} (${tClub('minor')})` : m.displayName,
            }))}
            plans={plans.map((p) => ({
              id: p.id,
              label: locale === 'en' && p.nameEn ? p.nameEn : p.nameBg,
              price: euroInputValue(p.priceCents, locale),
              priceText: formatEuro(p.priceCents, locale),
            }))}
            defaultMemberId={isUuid(query.chlen) ? query.chlen : null}
            defaultPlanId={isUuid(query.plan) ? query.plan : null}
          />
        </section>
      )}
    </main>
  );
}

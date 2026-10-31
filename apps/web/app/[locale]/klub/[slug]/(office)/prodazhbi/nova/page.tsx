import { clubHasFeature, lowestTierWith } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { TillForm } from '@/components/clubs/till-form';
import { Link } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { featureOn } from '@/lib/clubs/features';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { CLUB_PRODUCT_CATEGORIES } from '@/lib/clubs/input';
import { memberChoices } from '@/lib/clubs/members';
import { clubLocations } from '@/lib/clubs/settings';
import { clubProducts } from '@/lib/clubs/shop';

import { previewTillAction, tillSaleAction } from '../actions';

export const dynamic = 'force-dynamic';

/** The till (0049, wave B1). Not a fiscal device — and it says so. */
export default async function ClubTillPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor, club } = await requireClubStaff(slug, 'shop.sell');
  const [t, tClub, messages] = await Promise.all([
    getTranslations('ClubShop'),
    getTranslations('Club'),
    clubFormMessages(),
  ]);

  if (!featureOn(club, 'shop')) {
    return (
      <main className="space-y-4">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('tillTitle')}</h1>
        <p className="max-w-prose text-body-sm text-ink-soft">
          {clubHasFeature(club.tier, 'shop')
            ? t('switchedOff')
            : t('upsell', { tier: tClub(`tier.${lowestTierWith('shop')}`) })}
        </p>
      </main>
    );
  }

  const [products, members, locations] = await Promise.all([
    clubProducts(actor),
    memberChoices(actor),
    clubLocations(actor),
  ]);
  return (
    <main className="space-y-4">
      <Link
        href={`/klub/${slug}/prodazhbi`}
        className="text-body-sm font-semibold text-link hover:text-link-hover"
      >
        ← {t('salesTitle')}
      </Link>
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('tillTitle')}</h1>
      {products.length === 0 ? (
        <p className="text-body-sm text-text-muted">{t('tillEmpty')}</p>
      ) : (
        <TillForm
          action={tillSaleAction}
          preview={previewTillAction}
          slug={slug}
          locale={locale}
          messages={messages}
          offers={featureOn(club, 'promotions')}
          wallet={featureOn(club, 'wallet')}
          products={products.map((p) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            category: p.category,
            priceCents: p.priceCents,
          }))}
          members={members.map((m) => ({ id: m.id, label: m.displayName }))}
          locations={locations.map((l) => ({ id: l.id, name: l.name }))}
          labels={{
            search: t('search'),
            cart: t('cart'),
            empty: t('cartEmpty'),
            member: t('member'),
            walkIn: t('walkIn'),
            method: t('method'),
            methods: {
              cash: tClub('method.cash'),
              card_desk: tClub('method.card_desk'),
              other: tClub('method.other'),
              wallet: tClub('method.wallet'),
              account: t('onAccount'),
            },
            code: t('code'),
            location: t('location'),
            total: t('total'),
            record: t('record'),
            notFiscal: t('notFiscal'),
            offersNote: t('offersNote'),
            offer: t('offer'),
            less: t('less'),
            more: t('more'),
            categories: Object.fromEntries(
              CLUB_PRODUCT_CATEGORIES.map((c) => [c, t(`categories.${c}`)]),
            ),
          }}
        />
      )}
    </main>
  );
}

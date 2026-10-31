import {
  CLUB_KINDS,
  CLUB_TIER_PRICE_CENTS,
  CLUB_TIERS,
  CLUB_TRIAL_DAYS,
  COMMUNITY_MEMBER_CAP,
  formatEuro,
} from '@sportkarta/lib/clubs';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { ApplicationForm } from '@/components/clubs/application-form';
import { AppShell } from '@/components/shell/app-shell';
import { requireUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { clubSportOptions } from '@/lib/clubs/labels';
import { municipalityChoices } from '@/lib/clubs/settings';

import { applyAction } from './actions';

export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubApply' });
  return { title: t('title'), robots: { index: false, follow: false } };
}

export default async function ClubApplicationPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  await requireUser();
  const [t, tClub, messages, sports, cities] = await Promise.all([
    getTranslations('ClubApply'),
    getTranslations('Club'),
    clubFormMessages(),
    clubSportOptions(locale),
    municipalityChoices(),
  ]);

  return (
    <AppShell active={null}>
      <main className="mx-auto max-w-2xl space-y-5 p-4">
        <header className="space-y-2 border-b border-line pb-3">
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
          <p className="text-body-sm text-ink-soft">{t('intro')}</p>
        </header>
        <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
          <ApplicationForm
            action={applyAction}
            messages={messages}
            labels={{
              name: t('name'),
              kind: t('kind'),
              kinds: Object.fromEntries(CLUB_KINDS.map((kind) => [kind, tClub(`kind.${kind}`)])),
              tier: t('tier'),
              tiers: CLUB_TIERS.map((tier) => ({
                value: tier,
                label: tClub(`tier.${tier}`),
                hint: t(`tierHint.${tier}`, {
                  price: formatEuro(CLUB_TIER_PRICE_CENTS[tier], locale),
                  days: CLUB_TRIAL_DAYS,
                  cap: COMMUNITY_MEMBER_CAP,
                }),
              })),
              city: t('city'),
              cityNone: t('cityNone'),
              cities: cities.map((city) => ({
                id: city.id,
                name: locale === 'en' ? city.nameEn : city.nameBg,
              })),
              sports: t('sports'),
              sportOptions: sports,
              website: t('website'),
              description: t('description'),
              acceptTerms: t('acceptTerms'),
              submit: t('submit'),
            }}
          />
        </section>
        <section className="space-y-1">
          <h2 className="text-body font-bold text-ink">{t('afterTitle')}</h2>
          <p className="text-body-sm text-ink-soft">{t('after')}</p>
        </section>
      </main>
    </AppShell>
  );
}

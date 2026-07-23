import { getTranslations, setRequestLocale } from 'next-intl/server';

import { requireRole } from '@/lib/auth-session';
import { cityDisplayName, loadCityCatalog } from '@/lib/places';
import { CANONICAL_SPORTS } from '@sportkarta/lib/sports';

import { createCampaignAction } from '../actions';
import { CampaignForm } from '../campaign-form';

export const dynamic = 'force-dynamic';

export default async function NewCampaignPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireRole('admin');
  const [t, sportName, catalog] = await Promise.all([
    getTranslations('AdminCampaigns'),
    getTranslations('Sport'),
    loadCityCatalog(),
  ]);

  // Sport labels are resolved server-side and handed to the client component:
  // the form is a client component and next-intl's server catalogue is not
  // available there, and duplicating 28 sport names would drift.
  const sportLabels = Object.fromEntries(
    CANONICAL_SPORTS.map((sport) => [sport, sportName(sport)]),
  );
  const cities = catalog.all.map((city) => ({
    id: city.id,
    name: cityDisplayName(city.nameBg, city.nameEn, locale),
  }));

  return (
    <main className="max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold">{t('newCampaign')}</h1>
      <CampaignForm action={createCampaignAction} cities={cities} sportLabels={sportLabels} />
    </main>
  );
}

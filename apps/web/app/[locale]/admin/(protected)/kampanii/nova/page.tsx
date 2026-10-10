import { campaignQuarters, getDb } from '@sportkarta/db';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { requireRole } from '@/lib/auth-session';
import { inReadingOrder } from '@/lib/format';
import { cityDisplayName, loadCityCatalog } from '@/lib/places';
import { partnerText, sponsorCandidates } from '@/lib/partners';
import { CANONICAL_SPORTS } from '@sportkarta/lib/sports';

import { createCampaignAction } from '../actions';
import { CampaignForm } from '../campaign-form';

export const dynamic = 'force-dynamic';

export default async function NewCampaignPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireRole('admin');
  const [t, sportName, catalog, sponsors, quarters] = await Promise.all([
    getTranslations('AdminCampaigns'),
    getTranslations('Sport'),
    loadCityCatalog(),
    sponsorCandidates(getDb()),
    campaignQuarters(getDb()),
  ]);

  // Sport labels are resolved server-side and handed to the client component:
  // the form is a client component and next-intl's server catalogue is not
  // available there, and duplicating 28 sport names would drift. In the
  // reader's alphabetical order — the slugs' order reads as none in Bulgarian.
  const sports = inReadingOrder(CANONICAL_SPORTS, locale, (sport) => sportName(sport)).map(
    (sport) => ({ value: sport, label: sportName(sport) }),
  );
  const cities = catalog.all.map((city) => ({
    id: city.id,
    name: cityDisplayName(city.nameBg, city.nameEn, locale),
  }));

  return (
    <main className="max-w-2xl space-y-6">
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('newCampaign')}</h1>
      <CampaignForm
        action={createCampaignAction}
        cities={cities}
        quarters={quarters}
        sports={sports}
        partners={sponsors.map((p) => ({
          id: p.id,
          name: partnerText(p.nameBg, p.nameEn, locale) ?? p.nameBg,
        }))}
      />
    </main>
  );
}

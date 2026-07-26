import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { AdSlot } from '@/components/ads/ad-slot';
import { FacilityList } from '@/components/places/facility-list';
import { HeadlineStrip } from '@/components/partners/headline-strip';
import { PlaceMap } from '@/components/map/place-map';
import { Link } from '@/i18n/navigation';
import {
  citySportCounts,
  getCityBySlug,
  scopedFacilities,
  scopedFacilityCount,
  type City,
} from '@/lib/places';
import { buildAlternates } from '@/lib/seo';
import { AppShell } from '@/components/shell/app-shell';

// Programmatic SEO page: rendered on-demand + cached (ISR), never at build
// (no DB during the Docker build). Thin-content guarded.
export const revalidate = 3600;

const MIN_FACILITIES = 3;
const LIST_LIMIT = 60;

type PageParams = Promise<{ locale: string; city: string }>;

function cityName(city: City, locale: string): string {
  return locale === 'en' ? city.nameEn : city.nameBg;
}

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, city: slug } = await params;
  const city = await getCityBySlug(slug);
  if (!city) return {};
  const count = await scopedFacilityCount(city.id);
  if (count < MIN_FACILITIES) return {};
  const t = await getTranslations({ locale, namespace: 'Places' });
  const name = cityName(city, locale);
  return {
    title: t('cityMetaTitle', { city: name }),
    description: t('cityMetaDescription', { city: name, count }),
    alternates: buildAlternates(`/igrishta/${city.slug}`, locale),
  };
}

export default async function CityPage({ params }: { params: PageParams }) {
  const { locale, city: slug } = await params;
  setRequestLocale(locale);

  const city = await getCityBySlug(slug);
  if (!city) notFound();
  const count = await scopedFacilityCount(city.id);
  if (count < MIN_FACILITIES) notFound();

  const [t, tSport, facilities, sportCounts] = await Promise.all([
    getTranslations('Places'),
    getTranslations('Sport'),
    scopedFacilities(city.id),
    citySportCounts(city.id),
  ]);
  const name = cityName(city, locale);
  const crossSports = sportCounts.filter((s) => s.count >= MIN_FACILITIES);

  return (
    <AppShell>
      <main className="mx-auto max-w-3xl space-y-6 p-4">
      <Link href="/" className="text-body-sm font-medium text-link hover:text-link-hover">
        {t('viewAllOnMap')}
      </Link>

      <header className="space-y-2">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('cityH1', { city: name })}</h1>
        <p className="text-ink-soft">{t('cityIntro', { city: name, count })}</p>
        {/* Stage 3.4: the accountability figures for this municipality. Linked
            from here rather than only from the sitemap — the person looking at
            a city's facilities is exactly the person who wants to know how it
            compares per resident. */}
        <p>
          <Link href={`/obshtina/${city.slug}`} className="text-body-sm font-medium text-link hover:text-link-hover">
            {t('accountabilityLink', { city: name })}
          </Link>
        </p>
      </header>

      {crossSports.length > 0 && (
        <section aria-labelledby="bysport-h">
          <h2 id="bysport-h" className="mb-2 text-h4 font-bold text-ink">
            {t('bySportHeading')}
          </h2>
          <ul className="flex flex-wrap gap-2">
            {crossSports.map((s) => (
              <li key={s.sport}>
                <Link
                  href={`/igrishta/${city.slug}/${s.sport}`}
                  className="rounded-full border border-line-strong px-3 py-1 text-sm hover:bg-paper-sunk"
                >
                  {tSport(s.sport)} <span className="text-text-muted">({s.count})</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="map-h">
        <h2 id="map-h" className="mb-2 text-h4 font-bold text-ink">
          {t('mapHeading')}
        </h2>
        <PlaceMap facilities={facilities} />
      </section>

      <section aria-labelledby="list-h">
        <h2 id="list-h" className="mb-2 text-h4 font-bold text-ink">
          {t('facilitiesHeading')}
        </h2>
        <FacilityList facilities={facilities.slice(0, LIST_LIMIT)} />
        {count > LIST_LIMIT && (
          <p className="mt-2 text-body-sm text-text-muted">
            {t('showingLimited', { shown: Math.min(LIST_LIMIT, facilities.length), total: count })}
          </p>
        )}
      </section>

      {/* MONETISATION §S5 ad surface, after the facility list. Renders nothing
          when the slot is unsold. */}
      <AdSlot slot="city_page" />

      {/* One of exactly two allowlisted strip surfaces (MONETISATION M1); the
          component itself ships disabled. See headline-strip.tsx. */}
      <HeadlineStrip />
      </main>
    </AppShell>
  );
}

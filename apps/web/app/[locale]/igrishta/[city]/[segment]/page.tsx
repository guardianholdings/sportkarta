import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { FacilityList } from '@/components/places/facility-list';
import { PlaceMap } from '@/components/map/place-map';
import { Link } from '@/i18n/navigation';
import {
  citiesForSport,
  citySportCounts,
  getCityBySlug,
  resolveSegmentScope,
  scopedFacilities,
  scopedFacilityCount,
  scopedMapPoints,
  segmentScopeOptions,
} from '@/lib/places';
import { capitalizeFirst, takesVav } from '@/lib/grammar';
import { cityName, listingCopy } from '@/lib/place-headings';
import { buildAlternates } from '@/lib/seo';
import { AppShell } from '@/components/shell/app-shell';
import { chipClass } from '@/components/ui/chip';

import { ListPager } from '../../list-pager';

// ISR: on-demand + cached hourly, never prerendered at build (no DB there).
// The empty generateStaticParams is what makes the window real — see the
// sibling [city]/page.tsx.
export const revalidate = 3600;

export function generateStaticParams(): { city: string; segment: string }[] {
  return [];
}

const MIN_FACILITIES = 3;

type PageParams = Promise<{ locale: string; city: string; segment: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, city: slug, segment } = await params;
  const city = await getCityBySlug(slug);
  if (!city) return {};
  // The [segment] is EITHER a canonical sport (allowlist) OR a quarter slug.
  const scope = await resolveSegmentScope(city.id, segment);
  if (!scope) return {};
  const count = await scopedFacilityCount(city.id, segmentScopeOptions(scope));
  if (count < MIN_FACILITIES) return {};

  const [t, tSport] = await Promise.all([
    getTranslations({ locale, namespace: 'Places' }),
    getTranslations({ locale, namespace: 'Sport' }),
  ]);
  // The same builder as pages 2..n (lib/place-headings.ts).
  const copy = listingCopy({ locale, t, tSport }, { city, scope, count });
  return {
    title: copy.metaTitle,
    description: copy.metaDescription,
    alternates: buildAlternates(`/igrishta/${city.slug}/${segment}`, locale),
  };
}

export default async function SegmentPage({ params }: { params: PageParams }) {
  const { locale, city: slug, segment } = await params;
  setRequestLocale(locale);

  const city = await getCityBySlug(slug);
  if (!city) notFound();
  const scope = await resolveSegmentScope(city.id, segment);
  if (!scope) notFound();
  const opts = segmentScopeOptions(scope);
  const count = await scopedFacilityCount(city.id, opts);
  if (count < MIN_FACILITIES) notFound();

  const [t, tSport, mapPoints, facilities] = await Promise.all([
    getTranslations('Places'),
    getTranslations('Sport'),
    scopedMapPoints(city.id, opts),
    scopedFacilities(city.id, opts),
  ]);
  const name = cityName(city, locale);
  // „във Варна", not „в Варна" — the catalogue branches on it (lib/grammar.ts).
  const cityVav = takesVav(name);

  const { heading } = listingCopy({ locale, t, tSport }, { city, scope, count });
  const intro =
    scope.kind === 'sport'
      ? t('sportIntro', { sport: tSport(scope.sport), city: name, cityVav, count })
      : t('quarterIntro', { quarter: scope.quarter, city: name, count });

  // Cross-links (sport pages only — richer internal-link graph).
  const [otherSports, sameSportCities] =
    scope.kind === 'sport'
      ? await Promise.all([
          citySportCounts(city.id).then((rows) =>
            rows.filter((s) => s.count >= MIN_FACILITIES && s.sport !== scope.sport),
          ),
          citiesForSport(scope.sport, city.id, MIN_FACILITIES),
        ])
      : [[], []];

  return (
    <AppShell>
      <main className="mx-auto max-w-3xl space-y-6 p-4">
        <Link
          href={`/igrishta/${city.slug}`}
          className="text-body-sm font-medium text-link hover:text-link-hover"
        >
          {t('backToCity', { city: name, cityVav })}
        </Link>

        <header className="space-y-2">
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{heading}</h1>
          <p className="text-ink-soft">{intro}</p>
        </header>

        <section aria-labelledby="map-h">
          <h2 id="map-h" className="mb-2 text-h4 font-bold text-ink">
            {t('mapHeading')}
          </h2>
          <PlaceMap facilities={mapPoints} />
          {mapPoints.length < count && (
            <p className="mt-2 text-body-sm text-text-muted">
              {t('mapLimited', { shown: mapPoints.length, total: count })}
            </p>
          )}
        </section>

        <section aria-labelledby="list-h">
          <h2 id="list-h" className="mb-2 text-h4 font-bold text-ink">
            {t('facilitiesHeading')}
          </h2>
          <FacilityList facilities={facilities} />
          <ListPager basePath={`/igrishta/${city.slug}/${segment}`} page={1} total={count} />
        </section>

        {otherSports.length > 0 && (
          <section aria-labelledby="others-h">
            <h2 id="others-h" className="mb-2 text-h4 font-bold text-ink">
              {t('otherSportsHeading', { city: name, cityVav })}
            </h2>
            <ul className="flex flex-wrap gap-2">
              {otherSports.map((s) => (
                <li key={s.sport}>
                  <Link href={`/igrishta/${city.slug}/${s.sport}`} className={chipClass()}>
                    {tSport(s.sport)} <span className="text-text-muted">({s.count})</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {scope.kind === 'sport' && sameSportCities.length > 0 && (
          <section aria-labelledby="cities-h">
            <h2 id="cities-h" className="mb-2 text-h4 font-bold text-ink">
              {t('sameSportOtherCitiesHeading', {
                sport: capitalizeFirst(tSport(scope.sport), locale),
              })}
            </h2>
            <ul className="flex flex-wrap gap-2">
              {sameSportCities.map(({ city: other, count: n }) => (
                <li key={other.slug}>
                  <Link href={`/igrishta/${other.slug}/${scope.sport}`} className={chipClass()}>
                    {cityName(other, locale)} <span className="text-text-muted">({n})</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </AppShell>
  );
}

import { CANONICAL_SPORTS } from '@sportkarta/lib/sports';
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
  resolveQuarterSlug,
  scopedFacilities,
  scopedFacilityCount,
  type City,
  type ScopeOptions,
} from '@/lib/places';
import { buildAlternates } from '@/lib/seo';
import { AppShell } from '@/components/shell/app-shell';
import { chipClass } from '@/components/ui/chip';

// ISR: on-demand + cached hourly, never prerendered at build (no DB there).
export const revalidate = 3600;

const MIN_FACILITIES = 3;
const LIST_LIMIT = 60;
const SPORT_SET = new Set<string>(CANONICAL_SPORTS);

type PageParams = Promise<{ locale: string; city: string; segment: string }>;

// The [segment] is EITHER a canonical sport (allowlist) OR a quarter slug.
type Scope = { kind: 'sport'; sport: string } | { kind: 'quarter'; quarter: string };

function cityName(city: City, locale: string): string {
  return locale === 'en' ? city.nameEn : city.nameBg;
}

async function resolveScope(cityId: number, segment: string): Promise<Scope | null> {
  if (SPORT_SET.has(segment)) return { kind: 'sport', sport: segment };
  const quarter = await resolveQuarterSlug(cityId, segment);
  return quarter ? { kind: 'quarter', quarter } : null;
}

function scopeOptions(scope: Scope): ScopeOptions {
  return scope.kind === 'sport' ? { sport: scope.sport } : { quarter: scope.quarter };
}

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, city: slug, segment } = await params;
  const city = await getCityBySlug(slug);
  if (!city) return {};
  const scope = await resolveScope(city.id, segment);
  if (!scope) return {};
  const count = await scopedFacilityCount(city.id, scopeOptions(scope));
  if (count < MIN_FACILITIES) return {};

  const [t, tSport] = await Promise.all([
    getTranslations({ locale, namespace: 'Places' }),
    getTranslations({ locale, namespace: 'Sport' }),
  ]);
  const name = cityName(city, locale);
  const alternates = buildAlternates(`/igrishta/${city.slug}/${segment}`, locale);

  if (scope.kind === 'sport') {
    const sport = tSport(scope.sport);
    return {
      title: t('sportMetaTitle', { sport, city: name }),
      description: t('sportMetaDescription', { sport, city: name, count }),
      alternates,
    };
  }
  return {
    title: t('quarterMetaTitle', { quarter: scope.quarter, city: name }),
    description: t('quarterMetaDescription', { quarter: scope.quarter, city: name, count }),
    alternates,
  };
}

export default async function SegmentPage({ params }: { params: PageParams }) {
  const { locale, city: slug, segment } = await params;
  setRequestLocale(locale);

  const city = await getCityBySlug(slug);
  if (!city) notFound();
  const scope = await resolveScope(city.id, segment);
  if (!scope) notFound();
  const opts = scopeOptions(scope);
  const count = await scopedFacilityCount(city.id, opts);
  if (count < MIN_FACILITIES) notFound();

  const [t, tSport, facilities] = await Promise.all([
    getTranslations('Places'),
    getTranslations('Sport'),
    scopedFacilities(city.id, opts),
  ]);
  const name = cityName(city, locale);

  const heading =
    scope.kind === 'sport'
      ? t('sportH1', { sport: tSport(scope.sport), city: name })
      : t('quarterH1', { quarter: scope.quarter, city: name });
  const intro =
    scope.kind === 'sport'
      ? t('sportIntro', { sport: tSport(scope.sport), city: name, count })
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
          {t('backToCity', { city: name })}
        </Link>

        <header className="space-y-2">
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{heading}</h1>
          <p className="text-ink-soft">{intro}</p>
        </header>

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
              {t('showingLimited', {
                shown: Math.min(LIST_LIMIT, facilities.length),
                total: count,
              })}
            </p>
          )}
        </section>

        {otherSports.length > 0 && (
          <section aria-labelledby="others-h">
            <h2 id="others-h" className="mb-2 text-h4 font-bold text-ink">
              {t('otherSportsHeading', { city: name })}
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
              {t('sameSportOtherCitiesHeading', { sport: tSport(scope.sport) })}
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

import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { ReportForm } from '@/components/facility/report-form';
import { MiniMapLoader } from '@/components/map/mini-map-loader';
import { Link } from '@/i18n/navigation';
import { issueFormToken } from '@/lib/form-token';
import { serializeJsonLd } from '@/lib/json-ld';
import { buildAlternates } from '@/lib/seo';
import { getFacilityBySlug, type FacilityDetail } from '@/lib/public-data';

type PageParams = Promise<{ locale: string; slug: string }>;

// Facility photos are served from the storage volume under this prefix
// (lib/src/storage default). Stage 2 has none yet; Stage 3 adds uploads.
const UPLOADS_PREFIX = '/uploads';

function displayName(facility: FacilityDetail, fallback: string): string {
  return facility.name ?? fallback;
}

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, slug } = await params;
  const [facility, t] = await Promise.all([
    getFacilityBySlug(slug),
    getTranslations({ locale, namespace: 'Facility' }),
  ]);
  if (!facility) return { title: t('notFound') };
  const name = displayName(facility, t('unnamed'));
  const place = facility.municipalityName ?? facility.quarter ?? '';
  return {
    title: place ? `${name} — ${place}` : name,
    alternates: buildAlternates(`/obekt/${facility.slug}`, locale),
  };
}

export default async function FacilityPage({ params }: { params: PageParams }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);

  const [facility, t, tSport, tSurface, tAccess, tSource] = await Promise.all([
    getFacilityBySlug(slug),
    getTranslations('Facility'),
    getTranslations('Sport'),
    getTranslations('Surface'),
    getTranslations('Access'),
    getTranslations('Source'),
  ]);
  if (!facility) notFound();

  const name = displayName(facility, t('unnamed'));
  const sportLabels = facility.sportTypes.map((s) => tSport(s));

  // Lighting is tri-state: false is a definite "no", null is "unknown" — the
  // two must read differently (CLAUDE.md: distinguish unknown vs no).
  const lightingText =
    facility.lighting === null ? t('unknown') : facility.lighting ? t('yes') : t('no');
  const surfaceText = facility.surface ? tSurface(facility.surface) : t('unknown');

  const lastVerified = facility.lastVerifiedAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(
        new Date(facility.lastVerifiedAt),
      )
    : null;

  // schema.org SportsActivityLocation — sport names in the current locale.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SportsActivityLocation',
    name,
    geo: { '@type': 'GeoCoordinates', latitude: facility.lat, longitude: facility.lon },
    address: {
      '@type': 'PostalAddress',
      addressLocality: facility.municipalityName ?? facility.quarter ?? undefined,
      addressCountry: 'BG',
    },
    sport: sportLabels.length > 0 ? sportLabels : undefined,
    isAccessibleForFree: facility.access === 'free',
    publicAccess: facility.access === 'free',
  };

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-4">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />

      <Link href="/" className="text-sm underline">
        {t('backToMap')}
      </Link>

      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{name}</h1>
        {(facility.quarter || facility.municipalityName) && (
          <p className="text-neutral-600">
            {[facility.quarter, facility.municipalityName].filter(Boolean).join(', ')}
          </p>
        )}
      </header>

      <section aria-labelledby="attrs-h">
        <h2 id="attrs-h" className="mb-2 text-lg font-semibold">
          {t('attributes')}
        </h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="font-medium text-neutral-500">{t('access')}</dt>
          <dd>{tAccess(facility.access)}</dd>

          <dt className="font-medium text-neutral-500">{t('sports')}</dt>
          <dd>{sportLabels.length > 0 ? sportLabels.join(', ') : '—'}</dd>

          <dt className="font-medium text-neutral-500">{t('surface')}</dt>
          <dd>{surfaceText}</dd>

          <dt className="font-medium text-neutral-500">{t('lighting')}</dt>
          <dd>{lightingText}</dd>

          <dt className="font-medium text-neutral-500">{t('covered')}</dt>
          <dd>{facility.covered ? t('yes') : t('no')}</dd>

          <dt className="font-medium text-neutral-500">{t('dataSource')}</dt>
          <dd>{tSource(facility.source)}</dd>
        </dl>
        <p className="mt-3 text-sm text-neutral-500">
          {lastVerified ? t('lastVerified', { date: lastVerified }) : t('neverVerified')}
        </p>
      </section>

      {facility.photos.length > 0 && (
        <section aria-labelledby="photos-h">
          <h2 id="photos-h" className="mb-2 text-lg font-semibold">
            {t('photos')}
          </h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {facility.photos.map((path) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={path}
                src={`${UPLOADS_PREFIX}/${path}`}
                alt={t('photoAlt', { name })}
                loading="lazy"
                className="aspect-square w-full rounded-lg object-cover"
              />
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="loc-h">
        <h2 id="loc-h" className="mb-2 text-lg font-semibold">
          {t('location')}
        </h2>
        <MiniMapLoader lon={facility.lon} lat={facility.lat} label={name} />
      </section>

      <section>
        <ReportForm slug={facility.slug} formToken={issueFormToken()} />
      </section>
    </main>
  );
}

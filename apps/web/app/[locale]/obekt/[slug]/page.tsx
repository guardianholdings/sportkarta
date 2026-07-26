import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { AdSlot } from '@/components/ads/ad-slot';
import { buildShare } from '@sportkarta/lib/share';

import { FacilityDetailView } from '@/components/facility/facility-detail-view';
import { FacilityLegendBlock } from '@/components/facility/facility-legend';
import { ShareSheet } from '@/components/share/share-sheet';
import { siteUrl } from '@/lib/seo';
import { shareSheetStrings } from '@/lib/share/sheet-strings';
import { FacilitySponsorBlock } from '@/components/facility/facility-sponsor';
import { ReportForm } from '@/components/facility/report-form';
import { MiniMapLoader } from '@/components/map/mini-map-loader';
import { getCurrentUser } from '@/lib/auth-session';
import { addedPoints } from '@/lib/contributions/added-banner';
import { issueFormToken } from '@/lib/form-token';
import { serializeJsonLd } from '@/lib/json-ld';
import { buildAlternates } from '@/lib/seo';
import { getFacilityBySlug, type FacilityDetail } from '@/lib/public-data';
import { Link } from '@/i18n/navigation';

import { ConditionForm } from './condition-form';
import { VerifyForm } from './verify-form';

type PageParams = Promise<{ locale: string; slug: string }>;
type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

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
  const title = place ? `${name} — ${place}` : name;
  // C2: the card is a separate URL under /og — NOT /api (robots.ts disallows it
  // and the scrapers honour that) and dotted, so middleware does not
  // locale-rewrite it. See the route for the full reasoning.
  const card = `/og/${locale}/obekt/${facility.slug}/card.png`;
  return {
    title,
    alternates: buildAlternates(`/obekt/${facility.slug}`, locale),
    openGraph: { title, type: 'website', images: [{ url: card, width: 1200, height: 630 }] },
  };
}

function SectionCard({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-surface p-4 shadow-sm sm:p-5">
      {title && <h2 className="mb-3 text-h4 font-bold text-ink">{title}</h2>}
      {children}
    </section>
  );
}

export default async function FacilityPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: PageSearchParams;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);

  const [facility, currentUser, t, tSport, tContribute, tAdd, tShareSheet, query] =
    await Promise.all([
      getFacilityBySlug(slug),
      getCurrentUser(),
      getTranslations('Facility'),
      getTranslations('Sport'),
      getTranslations('Contribute'),
      getTranslations('AddFacility'),
      getTranslations('ShareSheet'),
      searchParams,
    ]);
  if (!facility) notFound();

  const justAdded = addedPoints(query.added);

  const name = displayName(facility, t('unnamed'));
  const sportLabels = facility.sportTypes.map((s) => tSport(s));

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
    <main className="mx-auto max-w-2xl px-4 py-5">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />

      {justAdded !== null && (
        <div
          role="status"
          className="mb-4 rounded-card border border-accent-border bg-accent-subtle p-4"
        >
          <p className="text-h4 font-bold text-accent-active">
            {tContribute('thanksWithPoints', { points: justAdded })}
          </p>
          <p className="mt-1 text-body-sm text-ink-soft">{tAdd('moderationNote')}</p>
        </div>
      )}

      <Link
        href="/"
        className="mb-4 inline-flex items-center gap-1.5 text-body-sm font-medium text-ink-soft hover:text-brand"
      >
        {t('backToMap')}
      </Link>

      <div className="flex flex-col gap-4">
        <div className="overflow-hidden rounded-card border border-line bg-surface shadow-sm">
          <FacilityDetailView facility={facility} />
        </div>

        {/* Adopt-a-facility (MONETISATION S3): high on the page, because it is
            about this facility, and never inside FacilityDetailView — sponsorship
            stays out of the shape the provenance line and JSON-LD read. Renders
            nothing when the facility is unadopted. */}
        <FacilitySponsorBlock facilityId={facility.id} />

        {/* B1. A sibling, never inside FacilityDetailView — that component's
            prop shape is read by the JSON-LD block and the provenance line,
            and a legend is a fact ABOUT the place rather than part of its
            record. Names nobody: this page is indexed. */}
        <FacilityLegendBlock facilityId={facility.id} viewerId={currentUser?.id ?? null} />

        {/*
          The facility share — the one that RECRUITS rather than announces, and
          the reason it sits on the highest-traffic public page. Nothing here is
          person-scoped: a place, its sports and its story image are all already
          public, so this share is cacheable and scraper-fetchable, unlike every
          share on /pasport or /trenirovki.
        */}
        <ShareSheet
          payload={buildShare({
            kind: 'facility',
            locale,
            origin: siteUrl(),
            page: `/obekt/${slug}`,
            ref: slug,
            text: tShareSheet('textFacility', { place: facility.name ?? slug }),
          })}
          strings={await shareSheetStrings('facility')}
        />

        {facility.photos.length > 1 && (
          <SectionCard title={t('photos')}>
            <div className="grid grid-cols-3 gap-2">
              {facility.photos.slice(1).map((path) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={path}
                  src={`${UPLOADS_PREFIX}/${path}`}
                  alt={t('photoAlt', { name })}
                  loading="lazy"
                  className="aspect-square w-full rounded-md object-cover"
                />
              ))}
            </div>
          </SectionCard>
        )}

        <SectionCard title={t('location')}>
          <div className="overflow-hidden rounded-md">
            <MiniMapLoader lon={facility.lon} lat={facility.lat} label={name} />
          </div>
        </SectionCard>

        <SectionCard title={tContribute('title')}>
          {currentUser ? (
            <div className="flex flex-col gap-6">
              <div>
                <h3 className="mb-3 text-body-sm font-bold text-ink">
                  {tContribute('verifyHeading')}
                </h3>
                <VerifyForm
                  slug={facility.slug}
                  access={facility.access}
                  surface={facility.surface}
                  lighting={facility.lighting}
                  covered={facility.covered}
                  sportTypes={facility.sportTypes}
                />
              </div>
              <div className="border-t border-line pt-6">
                <h3 className="mb-3 text-body-sm font-bold text-ink">
                  {tContribute('conditionHeading')}
                </h3>
                <ConditionForm slug={facility.slug} />
              </div>
            </div>
          ) : (
            <p className="text-body-sm text-ink-soft">
              <Link
                href={{ pathname: '/vhod', query: { next: `/obekt/${facility.slug}` } }}
                className="font-medium text-brand hover:text-brand-hover"
              >
                {tContribute('signInToContribute')}
              </Link>
            </p>
          )}
        </SectionCard>

        <SectionCard>
          <ReportForm slug={facility.slug} formToken={issueFormToken()} />
        </SectionCard>

        {/* One of the four ad surfaces in MONETISATION §S5 — the highest-volume
            SEO page. Renders nothing when the slot is unsold. */}
        <AdSlot slot="facility_page" />
      </div>
    </main>
  );
}

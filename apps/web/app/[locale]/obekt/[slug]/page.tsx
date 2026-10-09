import { getDb } from '@sportkarta/db';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { cache } from 'react';

import { AdSlot } from '@/components/ads/ad-slot';
import { buildShare } from '@sportkarta/lib/share';

import { FacilityDetailView } from '@/components/facility/facility-detail-view';
import { FacilityLegendBlock } from '@/components/facility/facility-legend';
import { facilityTitle, type LabelStrings } from '@/components/map/facility-label';
import { ShareSheet } from '@/components/share/share-sheet';
import { facilitySharePlace } from '@/lib/share/facility-place';
import { siteUrl } from '@/lib/seo';
import { shareSheetStrings } from '@/lib/share/sheet-strings';
import { FacilitySponsorBlock } from '@/components/facility/facility-sponsor';
import { ReportForm } from '@/components/facility/report-form';
import { MiniMapLoader } from '@/components/map/mini-map-loader';
import { getCurrentUser } from '@/lib/auth-session';
import { signInHref } from '@/lib/sign-in-destination';
import { withLocalizedArea } from '@/lib/area-name';
import { addedAway, addedBanner } from '@/lib/contributions/added-banner';
import { thanksMessage } from '@/lib/contributions/feedback';
import { isFacilityAuthor } from '@/lib/contributions/verify-facility';
import { issueFormToken } from '@/lib/form-token';
import { placeLabel } from '@/lib/geo';
import { serializeJsonLd } from '@/lib/json-ld';
import { buildAlternates } from '@/lib/seo';
import { photoUrl } from '@/lib/photo-url';
import { getFacilityBySlug, type FacilityDetail } from '@/lib/public-data';
import { Link } from '@/i18n/navigation';

import { ConditionForm } from './condition-form';
import { VerifyForm } from './verify-form';
import { AppShell } from '@/components/shell/app-shell';

type PageParams = Promise<{ locale: string; slug: string }>;
type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * One facility query per request. generateMetadata and the page both need it,
 * and on this dynamic page nothing else would share the result between them —
 * getFacilityBySlug runs three correlated subqueries, twice per view.
 */
const facilityBySlug = cache(getFacilityBySlug);

/**
 * What the facility is called on this page, in its title and in its JSON-LD:
 * the same name the map list, the pin and the place pages give it
 * (components/map/facility-label.ts). 93% of the corpus has no name, and the
 * page used to call every one of them «Спортно съоръжение» — so ~5,600 pages
 * shared a handful of titles, and a member who tapped «Фитнес — София» in the
 * list landed on a page that did not say so (UX audit 2026-10-10).
 */
function headingOf(facility: FacilityDetail, labels: LabelStrings): string {
  return facilityTitle(
    {
      name: facility.name,
      sports: facility.sportTypes,
      place: placeLabel(facility.quarter, facility.municipalityName),
    },
    labels,
  );
}

/** The map, opened on this facility with its card — not the country view. */
function mapHref(facility: FacilityDetail): string {
  return `/?selected=${encodeURIComponent(facility.slug)}&z=16&lat=${facility.lat.toFixed(5)}&lng=${facility.lon.toFixed(5)}`;
}

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, slug } = await params;
  const [found, t, tSport, tAccess] = await Promise.all([
    facilityBySlug(slug),
    getTranslations({ locale, namespace: 'Facility' }),
    getTranslations({ locale, namespace: 'Sport' }),
    getTranslations({ locale, namespace: 'Access' }),
  ]);
  if (!found) return { title: t('notFound') };
  const facility = await withLocalizedArea(found, locale);
  const heading = headingOf(facility, {
    locale,
    unnamed: t('unnamed'),
    sport: (sport) => tSport(sport),
    unnamedAt: (what, place) => t('unnamedAt', { what, place }),
  });
  // An unnamed facility's heading already ends in its place.
  const place = placeLabel(facility.quarter, facility.municipalityName);
  const title = facility.name?.trim() && place ? `${heading} — ${place}` : heading;
  // Its own description instead of the site's: the facts a searcher compares.
  const description = t('metaDescription', {
    title,
    sports: facility.sportTypes.map((sport) => tSport(sport)).join(', ') || t('unnamed'),
    access: tAccess(facility.access),
  });
  // C2: the card is a separate URL under /og — NOT /api (robots.ts disallows it
  // and the scrapers honour that) and dotted, so middleware does not
  // locale-rewrite it. See the route for the full reasoning.
  const card = `/og/${locale}/obekt/${facility.slug}/card.png`;
  return {
    title,
    description,
    alternates: buildAlternates(`/obekt/${facility.slug}`, locale),
    openGraph: {
      title,
      description,
      type: 'website',
      images: [{ url: card, width: 1200, height: 630 }],
    },
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

  const [found, currentUser, t, tSport, tContribute, tAdd, tShareSheet, query] = await Promise.all([
    facilityBySlug(slug),
    getCurrentUser(),
    getTranslations('Facility'),
    getTranslations('Sport'),
    getTranslations('Contribute'),
    getTranslations('AddFacility'),
    getTranslations('ShareSheet'),
    searchParams,
  ]);
  // A real 404: no loading boundary sits above this route (see
  // components/shell/route-loading.tsx), so this runs before the first byte.
  if (!found) notFound();
  const facility = await withLocalizedArea(found, locale);

  // The one-shot thanks after /dobavi, and — when the add earned nothing — why
  // (lib/contributions/added-banner.ts). The photo is always still in review.
  const justAdded = addedBanner(query.added);
  const addedThanks = justAdded
    ? thanksMessage({ awarded: justAdded.points ?? 0, ...addedAway(query.away) })
    : null;
  // The author cannot confirm their own facility (verifyFacility refuses it),
  // so they are told that instead of being handed a checklist that will fail.
  const isAuthor = currentUser
    ? await isFacilityAuthor(getDb(), facility.id, currentUser.id)
    : false;

  const name = headingOf(facility, {
    locale,
    unnamed: t('unnamed'),
    sport: (sport) => tSport(sport),
    unnamedAt: (what, place) => t('unnamedAt', { what, place }),
  });
  const origin = siteUrl();

  // `sport` is not a SportsActivityLocation property (structured-data
  // validators reject it); the URL and an image are what the type is missing.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SportsActivityLocation',
    name,
    url: `${origin}${locale === 'bg' ? '' : `/${locale}`}/obekt/${facility.slug}`,
    image: `${origin}/og/${locale}/obekt/${facility.slug}/card.png`,
    geo: { '@type': 'GeoCoordinates', latitude: facility.lat, longitude: facility.lon },
    address: {
      '@type': 'PostalAddress',
      addressLocality: facility.municipalityName ?? facility.quarter ?? undefined,
      addressCountry: 'BG',
    },
    isAccessibleForFree: facility.access === 'free',
    publicAccess: facility.access === 'free',
  };

  return (
    <AppShell>
      <main className="mx-auto max-w-2xl px-4 py-5">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
        />

        {addedThanks !== null && (
          <div
            role="status"
            className="mb-4 rounded-card border border-accent-border bg-accent-subtle p-4"
          >
            <p className="text-h4 font-bold text-accent-active">
              {addedThanks.key === 'thanksWithPoints'
                ? tContribute('thanksWithPoints', { points: addedThanks.points })
                : addedThanks.key === 'offSiteNotice'
                  ? tContribute('offSiteNotice', { km: addedThanks.km })
                  : tContribute(addedThanks.key)}
            </p>
            <p className="mt-1 text-body-sm text-ink-soft">
              {tAdd('moderationNote')} {tAdd('photoPendingNote')}
            </p>
          </div>
        )}

        {/* Back to where the member came from in spirit: the map, on this
            facility — not the country view with every filter reset. */}
        <Link
          href={mapHref(facility)}
          className="mb-2 inline-flex min-h-11 items-center gap-1.5 text-body-sm font-medium text-ink-soft hover:text-brand"
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
              text: tShareSheet('textFacility', {
                place: facilitySharePlace(facility, t('unnamed')),
              }),
            })}
            strings={await shareSheetStrings('facility')}
          />

          {facility.photoIds.length > 1 && (
            <SectionCard title={t('photos')}>
              <div className="grid grid-cols-3 gap-2">
                {facility.photoIds.slice(1).map((photoId) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={photoId}
                    src={photoUrl(photoId)}
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
            <Link
              href={mapHref(facility)}
              className="mt-2 inline-flex min-h-11 items-center text-body-sm font-medium text-link hover:text-link-hover"
            >
              {t('openOnMap')}
            </Link>
          </SectionCard>

          <SectionCard title={tContribute('title')}>
            {currentUser ? (
              <div className="flex flex-col gap-6">
                <div>
                  <h3 className="mb-3 text-body-sm font-bold text-ink">
                    {tContribute('verifyHeading')}
                  </h3>
                  {isAuthor ? (
                    <p className="text-body-sm text-ink-soft">{tContribute('ownFacilityNotice')}</p>
                  ) : (
                    <VerifyForm
                      slug={facility.slug}
                      access={facility.access}
                      surface={facility.surface}
                      lighting={facility.lighting}
                      covered={facility.covered}
                      sportTypes={facility.sportTypes}
                    />
                  )}
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
                  href={signInHref(`/obekt/${facility.slug}`)}
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
    </AppShell>
  );
}

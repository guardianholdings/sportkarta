import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { listingCopy, type ListingCopy } from '@/lib/place-headings';
import {
  getCityBySlug,
  listPageCount,
  listPagePath,
  parseListPage,
  resolveSegmentScope,
  scopedFacilities,
  scopedFacilityCount,
  segmentScopeOptions,
  type City,
  type SegmentScope,
} from '@/lib/places';
import { buildAlternates } from '@/lib/seo';

import { PlaceListPage } from '../../../../list-page';

// List pages 2..n of a sport or quarter listing (page 1 is the segment page).
// Same ISR arrangement as the city list pages.
export const revalidate = 3600;

export function generateStaticParams(): { page: string }[] {
  return [];
}

type PageParams = Promise<{ locale: string; city: string; segment: string; page: string }>;

async function resolvePage(
  slug: string,
  segment: string,
  rawPage: string,
): Promise<{ city: City; scope: SegmentScope; page: number; total: number } | null> {
  const page = parseListPage(rawPage);
  if (page === null) return null;
  const city = await getCityBySlug(slug);
  if (!city) return null;
  const scope = await resolveSegmentScope(city.id, segment);
  if (!scope) return null;
  const total = await scopedFacilityCount(city.id, segmentScopeOptions(scope));
  return page <= listPageCount(total) ? { city, scope, page, total } : null;
}

/**
 * The segment page's own heading and metadata (lib/place-headings.ts), so page
 * n names the same listing — plus «— страница n от m» in the title.
 */
async function copyFor(
  locale: string,
  city: City,
  scope: SegmentScope,
  page: number,
  total: number,
): Promise<ListingCopy> {
  const [t, tSport] = await Promise.all([
    getTranslations({ locale, namespace: 'Places' }),
    getTranslations({ locale, namespace: 'Sport' }),
  ]);
  return listingCopy(
    { locale, t, tSport },
    { city, scope, count: total },
    { page, pages: listPageCount(total) },
  );
}

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, city: slug, segment, page: rawPage } = await params;
  const resolved = await resolvePage(slug, segment, rawPage);
  if (!resolved) return {};
  const { city, scope, page, total } = resolved;
  const copy = await copyFor(locale, city, scope, page, total);
  return {
    title: copy.metaTitle,
    description: copy.metaDescription,
    alternates: buildAlternates(listPagePath(`/igrishta/${city.slug}/${segment}`, page), locale),
  };
}

export default async function SegmentListPage({ params }: { params: PageParams }) {
  const { locale, city: slug, segment, page: rawPage } = await params;
  setRequestLocale(locale);

  const resolved = await resolvePage(slug, segment, rawPage);
  if (!resolved) notFound();
  const { city, scope, page, total } = resolved;

  const [{ heading }, facilities] = await Promise.all([
    copyFor(locale, city, scope, page, total),
    scopedFacilities(city.id, segmentScopeOptions(scope), page),
  ]);

  return (
    <PlaceListPage
      basePath={`/igrishta/${city.slug}/${segment}`}
      heading={heading}
      page={page}
      total={total}
      facilities={facilities}
    />
  );
}

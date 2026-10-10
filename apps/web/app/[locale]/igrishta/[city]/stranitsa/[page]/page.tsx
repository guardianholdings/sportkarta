import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { listingCopy, type ListingCopy } from '@/lib/place-headings';
import {
  getCityBySlug,
  listPageCount,
  listPagePath,
  parseListPage,
  scopedFacilities,
  scopedFacilityCount,
  type City,
} from '@/lib/places';
import { buildAlternates } from '@/lib/seo';

import { PlaceListPage } from '../../../list-page';

// List pages 2..n of a city (page 1 is /igrishta/[city] itself). ISR like the
// city page, and like it never prerendered at build — there is no database
// there. The empty generateStaticParams is what makes Next cache on-demand
// renders of a dynamic route at all.
export const revalidate = 3600;

export function generateStaticParams(): { page: string }[] {
  return [];
}

type PageParams = Promise<{ locale: string; city: string; page: string }>;

/**
 * The city and page, or null for anything that is not a real list page. No
 * thin-content guard is needed here: a page 2 exists only when the city has
 * more facilities than one page holds.
 */
async function resolvePage(
  slug: string,
  rawPage: string,
): Promise<{ city: City; page: number; total: number } | null> {
  const page = parseListPage(rawPage);
  if (page === null) return null;
  const city = await getCityBySlug(slug);
  if (!city) return null;
  const total = await scopedFacilityCount(city.id);
  return page <= listPageCount(total) ? { city, page, total } : null;
}

/** Page 1's own heading and metadata, plus «— страница n от m» in the title. */
async function copyFor(
  locale: string,
  city: City,
  page: number,
  total: number,
): Promise<ListingCopy> {
  const [t, tSport] = await Promise.all([
    getTranslations({ locale, namespace: 'Places' }),
    getTranslations({ locale, namespace: 'Sport' }),
  ]);
  return listingCopy(
    { locale, t, tSport },
    { city, scope: null, count: total },
    { page, pages: listPageCount(total) },
  );
}

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, city: slug, page: rawPage } = await params;
  const resolved = await resolvePage(slug, rawPage);
  if (!resolved) return {};
  const { city, page, total } = resolved;
  const copy = await copyFor(locale, city, page, total);
  return {
    title: copy.metaTitle,
    description: copy.metaDescription,
    alternates: buildAlternates(listPagePath(`/igrishta/${city.slug}`, page), locale),
  };
}

export default async function CityListPage({ params }: { params: PageParams }) {
  const { locale, city: slug, page: rawPage } = await params;
  setRequestLocale(locale);

  const resolved = await resolvePage(slug, rawPage);
  if (!resolved) notFound();
  const { city, page, total } = resolved;

  const [{ heading }, facilities] = await Promise.all([
    copyFor(locale, city, page, total),
    scopedFacilities(city.id, {}, page),
  ]);

  return (
    <PlaceListPage
      basePath={`/igrishta/${city.slug}`}
      heading={heading}
      page={page}
      total={total}
      facilities={facilities}
    />
  );
}

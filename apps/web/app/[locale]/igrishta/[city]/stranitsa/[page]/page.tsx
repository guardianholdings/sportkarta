import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

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

function cityName(city: City, locale: string): string {
  return locale === 'en' ? city.nameEn : city.nameBg;
}

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

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, city: slug, page: rawPage } = await params;
  const resolved = await resolvePage(slug, rawPage);
  if (!resolved) return {};
  const { city, page, total } = resolved;
  const t = await getTranslations({ locale, namespace: 'Places' });
  const name = cityName(city, locale);
  return {
    title: t('pagedHeading', {
      heading: t('cityMetaTitle', { city: name }),
      page,
      pages: listPageCount(total),
    }),
    description: t('cityMetaDescription', { city: name, count: total }),
    alternates: buildAlternates(listPagePath(`/igrishta/${city.slug}`, page), locale),
  };
}

export default async function CityListPage({ params }: { params: PageParams }) {
  const { locale, city: slug, page: rawPage } = await params;
  setRequestLocale(locale);

  const resolved = await resolvePage(slug, rawPage);
  if (!resolved) notFound();
  const { city, page, total } = resolved;

  const [t, facilities] = await Promise.all([
    getTranslations('Places'),
    scopedFacilities(city.id, {}, page),
  ]);

  return (
    <PlaceListPage
      basePath={`/igrishta/${city.slug}`}
      heading={t('cityH1', { city: cityName(city, locale) })}
      page={page}
      total={total}
      facilities={facilities}
    />
  );
}

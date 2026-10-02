import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

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

function cityName(city: City, locale: string): string {
  return locale === 'en' ? city.nameEn : city.nameBg;
}

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

/** The segment page's own heading and meta title, so page n names the same listing. */
async function headings(
  locale: string,
  city: City,
  scope: SegmentScope,
): Promise<{ heading: string; metaTitle: string }> {
  const [t, tSport] = await Promise.all([
    getTranslations({ locale, namespace: 'Places' }),
    getTranslations({ locale, namespace: 'Sport' }),
  ]);
  const name = cityName(city, locale);
  if (scope.kind === 'sport') {
    const sport = tSport(scope.sport);
    return {
      heading: t('sportH1', { sport, city: name }),
      metaTitle: t('sportMetaTitle', { sport, city: name }),
    };
  }
  return {
    heading: t('quarterH1', { quarter: scope.quarter, city: name }),
    metaTitle: t('quarterMetaTitle', { quarter: scope.quarter, city: name }),
  };
}

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, city: slug, segment, page: rawPage } = await params;
  const resolved = await resolvePage(slug, segment, rawPage);
  if (!resolved) return {};
  const { city, scope, page, total } = resolved;
  const t = await getTranslations({ locale, namespace: 'Places' });
  const { metaTitle } = await headings(locale, city, scope);
  return {
    title: t('pagedHeading', { heading: metaTitle, page, pages: listPageCount(total) }),
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
    headings(locale, city, scope),
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

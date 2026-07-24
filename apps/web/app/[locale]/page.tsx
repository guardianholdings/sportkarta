import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { MapExplorer } from '@/components/map/map-explorer';
import type { MapView } from '@/components/map/map-canvas';
import { parsePublicFilters } from '@/lib/filters';
import { listPublicFacilities } from '@/lib/public-data';
import { buildAlternates } from '@/lib/seo';

// Filter- and viewport-dependent, DB-backed: rendered per request.
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return { alternates: buildAlternates('/', locale) };
}

type SearchParams = Record<string, string | string[] | undefined>;

// Default to a whole-Bulgaria overview; a z/lat/lng in the URL (written as the
// user pans) restores their last viewport. Bounds match the data's bbox.
function parseView(sp: SearchParams): MapView {
  const z = Number(sp.z);
  const lat = Number(sp.lat);
  const lng = Number(sp.lng);
  if (
    Number.isFinite(z) &&
    z >= 0 &&
    z <= 20 &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= 41 &&
    lat <= 44.5 &&
    lng >= 22 &&
    lng <= 29
  ) {
    return { lng, lat, zoom: z };
  }
  return { lng: 25.3, lat: 42.72, zoom: 6.8 };
}

export default async function HomePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;

  const filters = parsePublicFilters(sp);
  const [t, facilities] = await Promise.all([
    getTranslations('Map'),
    listPublicFacilities(filters, 100),
  ]);

  return (
    <main>
      <h1 className="sr-only">{t('title')}</h1>
      <MapExplorer
        filters={filters}
        initialView={parseView(sp)}
        initialSelected={typeof sp.selected === 'string' ? sp.selected : null}
        initialFacilities={facilities.map((f) => ({
          slug: f.slug,
          name: f.name,
          sports: f.sportTypes,
          lon: f.lon,
          lat: f.lat,
        }))}
      />
    </main>
  );
}

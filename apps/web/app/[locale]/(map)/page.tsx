import type { Metadata } from 'next';
import { BULGARIA_CENTER, insideBulgaria } from '@sportkarta/lib/geo';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { adSlotProps } from '@/components/ads/ad-slot';
import { MapExplorer } from '@/components/map/map-explorer';
import type { MapView } from '@/components/map/map-canvas';
import { parsePublicFilters } from '@/lib/filters';
import { externalMapLayers } from '@/lib/map/external-layers';
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
  if (Number.isFinite(z) && z >= 0 && z <= 20 && insideBulgaria({ lon: lng, lat })) {
    return { lng, lat, zoom: z };
  }
  return { ...BULGARIA_CENTER };
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
  // The `map_panel` placement is resolved HERE, on the server, and handed to the
  // client explorer as three plain strings (MONETISATION §S5): the ad logic and
  // the database import stay out of the map bundle, and the map CANVAS stays
  // ad-free — the slot is a card at the foot of the list panel beside it.
  const [t, facilities, ad] = await Promise.all([
    getTranslations('Map'),
    listPublicFacilities(filters, 100),
    adSlotProps('map_panel'),
  ]);

  return (
    <main>
      <h1 className="sr-only">{t('title')}</h1>
      <MapExplorer
        filters={filters}
        initialView={parseView(sp)}
        initialSelected={typeof sp.selected === 'string' ? sp.selected : null}
        externalLayers={externalMapLayers()}
        ad={ad}
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

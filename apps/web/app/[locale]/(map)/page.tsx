import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { adSlotProps } from '@/components/ads/ad-slot';
import { MapExplorer } from '@/components/map/map-explorer';
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

  // The filters only choose the first paint's 100-row seed here. The explorer
  // reads the filters, the selection and the view from the address bar itself
  // (map-explorer.tsx, `writeUrl`), so a filter chip or a pin tap is no longer a
  // server render of this page.
  const filters = parsePublicFilters(sp);
  // The `map_panel` placement is resolved HERE, on the server, and handed to the
  // client explorer as three plain strings (MONETISATION §S5): the ad logic and
  // the database import stay out of the map bundle, and the map CANVAS stays
  // ad-free — the slot is a card at the foot of the list panel beside it.
  const [t, facilities, ad] = await Promise.all([
    getTranslations('Map'),
    listPublicFacilities(filters, 100, locale),
    adSlotProps('map_panel'),
  ]);

  return (
    <main>
      <h1 className="sr-only">{t('title')}</h1>
      <MapExplorer
        externalLayers={externalMapLayers()}
        ad={ad}
        initialFacilities={facilities.map((f) => ({
          slug: f.slug,
          name: f.name,
          sports: f.sportTypes,
          lon: f.lon,
          lat: f.lat,
          place: f.place,
        }))}
      />
    </main>
  );
}

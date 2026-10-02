'use client';

import { useLocale, useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';

import { useRouter } from '@/i18n/navigation';
import { viewFromPoints } from '@/lib/geo';

import { facilityTitle, type LabelStrings } from './facility-label';
import type { MapPoint } from './map-canvas';

// Reuses the main MapLibre canvas, scoped + framed to one place's facilities.
// Client-only (WebGL); the surrounding SEO page still server-renders its list.
const MapCanvas = dynamic(() => import('./map-canvas'), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-paper-sunk" />,
});

export interface PlaceMapFacility {
  slug: string;
  name: string | null;
  sportTypes: string[];
  lon: number;
  lat: number;
}

export function PlaceMap({ facilities }: { facilities: PlaceMapFacility[] }) {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('Map');
  const tFacility = useTranslations('Facility');
  const tSport = useTranslations('Sport');
  const points: MapPoint[] = facilities.map((f) => ({
    slug: f.slug,
    name: f.name,
    sports: f.sportTypes,
    lon: f.lon,
    lat: f.lat,
  }));
  const view = viewFromPoints(facilities.map((f) => ({ lon: f.lon, lat: f.lat })));
  // No `place`: the page around this map already IS the place. The label still
  // matters — it is each pin's accessible name, and without one every unnamed
  // pin here announced nothing at all.
  const labels: LabelStrings = {
    locale,
    unnamed: tFacility('unnamed'),
    sport: (sport) => tSport(sport),
    unnamedAt: (what, place) => tFacility('unnamedAt', { what, place }),
  };

  return (
    <div className="h-72 w-full overflow-hidden rounded-lg">
      <MapCanvas
        points={points}
        userLocation={null}
        selectedSlug={null}
        initialView={view}
        myLocationLabel=""
        labelFor={(point) => facilityTitle(point, labels)}
        clusterLabel={(count) => t('clusterLabel', { count })}
        unavailableLabel={t('mapUnavailable')}
        onSelect={(slug) => router.push(`/obekt/${slug}`)}
        onMoveEnd={() => undefined}
      />
    </div>
  );
}

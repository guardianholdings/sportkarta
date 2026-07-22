'use client';

import dynamic from 'next/dynamic';

import { useRouter } from '@/i18n/navigation';
import { viewFromPoints } from '@/lib/geo';

import type { MapPoint } from './map-canvas';

// Reuses the main MapLibre canvas, scoped + framed to one place's facilities.
// Client-only (WebGL); the surrounding SEO page still server-renders its list.
const MapCanvas = dynamic(() => import('./map-canvas'), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-neutral-100" />,
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
  const points: MapPoint[] = facilities.map((f) => ({
    slug: f.slug,
    name: f.name,
    sports: f.sportTypes,
    lon: f.lon,
    lat: f.lat,
  }));
  const view = viewFromPoints(facilities.map((f) => ({ lon: f.lon, lat: f.lat })));

  return (
    <div className="h-72 w-full overflow-hidden rounded-lg">
      <MapCanvas
        points={points}
        userLocation={null}
        selectedSlug={null}
        initialView={view}
        myLocationLabel=""
        onSelect={(slug) => router.push(`/obekt/${slug}`)}
        onMoveEnd={() => undefined}
      />
    </div>
  );
}

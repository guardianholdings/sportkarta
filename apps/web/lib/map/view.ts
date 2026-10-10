// The SUBPATH, never the barrel: the map explorer is a client component, and
// the barrel re-exports the mailer (tests/client-imports.test.ts).
import { insideBulgaria } from '@sportkarta/lib/geo';

import type { MapView } from '@/components/map/map-canvas';

/** Search params as Next hands them to a page, or as `Object.fromEntries` reads them. */
export type UrlParams = Record<string, string | string[] | undefined>;

/**
 * A z/lat/lng in the URL (written as the member pans) restores their last
 * viewport. Without one this returns NULL, and null means "fit the whole
 * country into the visible map" — which the canvas computes for the actual
 * screen.
 *
 * It used to return a fixed z6.8 centre for every device. That is a whole-
 * Bulgaria view only on a wide screen: a 390px phone at z6.8 spans about 2.5°
 * of longitude, 24.1–26.5 E, which left Sofia, Varna and Burgas — some 44% of
 * the facilities — off the first screen a visitor ever sees. A camera that
 * fits the country cannot be a constant, because the country is landscape and
 * the screens are not.
 *
 * Client-safe, because the explorer reads it from the address bar itself: the
 * URL, not the server render, is what knows where the member last was (see
 * map-explorer.tsx, `writeUrl`).
 */
export function parseView(sp: UrlParams): MapView | null {
  const z = Number(sp.z);
  const lat = Number(sp.lat);
  const lng = Number(sp.lng);
  if (Number.isFinite(z) && z >= 0 && z <= 20 && insideBulgaria({ lon: lng, lat })) {
    return { lng, lat, zoom: z };
  }
  return null;
}

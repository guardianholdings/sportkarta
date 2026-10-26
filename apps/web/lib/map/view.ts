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

/**
 * The address bar's query with the map's view written in, or taken out
 * (`null`). Every other parameter stays: the filters, a selection, a sticker
 * link's `blizo` and campaign tags.
 *
 * Five decimals of lat/lng is about a metre. That is right for a view the member
 * moved by hand, which a reload or a shared link should restore exactly. It is
 * wrong for the view the map flies to after locating them: that centre is where
 * they stand. For that view the canvas hands over `null` until they move the
 * map themselves (map-canvas.tsx, `locatedRef`), and the address then holds no
 * position at all.
 */
export function withView(search: string, view: MapView | null): string {
  const sp = new URLSearchParams(search);
  if (view) {
    sp.set('z', view.zoom.toFixed(2));
    sp.set('lat', view.lat.toFixed(5));
    sp.set('lng', view.lng.toFixed(5));
  } else {
    for (const key of ['z', 'lat', 'lng']) sp.delete(key);
  }
  return sp.toString();
}

// The SUBPATH, never the barrel: this module is imported by client components
// (the map explorer), and the barrel re-exports the mailer.
import { BULGARIA_CENTER } from '@sportkarta/lib/geo';

export interface LngLat {
  lon: number;
  lat: number;
}

const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in km (haversine) — for "nearest facility" sorting. */
export function distanceKm(a: LngLat, b: LngLat): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Round a km distance for display: one decimal under 10 km, whole km above —
 * in the reader's NUMBER FORMAT, which is half of why this takes a locale.
 *
 * It used to be `km.toFixed(1)`, which printed "0.4" to a Bulgarian reader whose
 * decimal separator is a comma ("0,4"). The unit is deliberately NOT added here:
 * "на {km} км" / "{km} km away" is copy, so it lives in messages/*.json and the
 * caller wraps this number in it.
 */
export function formatKm(km: number, locale: string): string {
  const digits = km < 10 ? 1 : 0;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(km);
}

/** "Лозенец, София" — shared with the worker's mail, so it lives in the lib. */
export { placeLabel } from '@sportkarta/lib/geo';

export interface MapView {
  lng: number;
  lat: number;
  zoom: number;
}

/**
 * A center + zoom that frames a set of points (for the scoped place maps).
 * Derives zoom from the bounding-box span; clamped to a sane range. Empty →
 * whole-Bulgaria overview (the one shared definition, not a local copy of its
 * numbers); a single point → close-in.
 */
export function viewFromPoints(points: LngLat[]): MapView {
  if (points.length === 0) return { ...BULGARIA_CENTER };
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const p of points) {
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
  }
  const lng = (minLon + maxLon) / 2;
  const lat = (minLat + maxLat) / 2;
  const span = Math.max(maxLon - minLon, maxLat - minLat);
  if (span <= 0) return { lng, lat, zoom: 14 };
  // 360° of longitude ≈ zoom 0; halve the span per zoom level. −1 adds padding.
  const zoom = Math.max(4, Math.min(15, Math.round(Math.log2(360 / span)) - 1));
  return { lng, lat, zoom };
}

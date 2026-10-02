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

/**
 * Where a facility is, as precisely as the data allows: "Лозенец, София",
 * or just the municipality when no quarter is recorded.
 *
 * This is what tells two unnamed facilities apart. 91% of the corpus has no
 * name — OSM rarely names a pitch — so without it the list was a column of
 * identical "Спортно съоръжение" rows. A quarter that merely repeats the
 * municipality ("Варна, Варна") is dropped rather than printed twice.
 */
export function placeLabel(
  quarter: string | null | undefined,
  municipality: string | null | undefined,
): string | null {
  const parts: string[] = [];
  for (const raw of [quarter, municipality]) {
    const part = raw?.trim();
    if (!part) continue;
    if (parts.some((p) => p.toLocaleLowerCase() === part.toLocaleLowerCase())) continue;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

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

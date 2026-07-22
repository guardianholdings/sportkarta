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

/** Round a km distance for display: one decimal under 10 km, whole km above. */
export function formatKm(km: number): string {
  return km < 10 ? km.toFixed(1) : String(Math.round(km));
}

export interface MapView {
  lng: number;
  lat: number;
  zoom: number;
}

const BULGARIA_CENTER: MapView = { lng: 25.3, lat: 42.72, zoom: 6.8 };

/**
 * A center + zoom that frames a set of points (for the scoped place maps).
 * Derives zoom from the bounding-box span; clamped to a sane range. Empty →
 * whole-Bulgaria overview; a single point → close-in.
 */
export function viewFromPoints(points: LngLat[]): MapView {
  if (points.length === 0) return BULGARIA_CENTER;
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

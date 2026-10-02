import { insideBulgaria } from '@sportkarta/lib/geo';

/**
 * Pure parsing for the admin facility editor's location field
 * (pre-launch audit finding 62).
 *
 * The editor could not move a pin: a crowd-added facility dropped on the wrong
 * street — or outside every municipality boundary, where no ambassador can see
 * it and no city page lists it — could only be marked gone. It now takes a
 * longitude and latitude; the municipality is recomputed from the point
 * (ST_Contains) in the same statement, never typed by hand.
 */

export interface Point {
  lon: number;
  lat: number;
}

/**
 * What the editor's lat/lon inputs show: six decimals ≈ 11 cm, the precision
 * the add-facility flow stores. The page pre-fills the form with THIS, and the
 * save compares against it, so the two cannot round differently.
 */
export function formatCoordinate(value: number): string {
  return value.toFixed(6);
}

/**
 * Six decimals, rounded exactly as the form displays them. Not
 * `Math.round(v * 1e6) / 1e6`: OSM centroids carry seven decimals, and on a
 * half-way value the two disagree (42.6977085 shows as 42.697708 but
 * Math.round gives 42.697709) — about one OSM facility in ten — so every save
 * of an untouched form recorded a phantom ~10 cm move, which as a crowd `geom`
 * edit froze the pin against every future import.
 */
function round6(value: number): number {
  return Number(formatCoordinate(value));
}

/**
 * `null` = the form left the location alone; `'invalid'` = something was typed
 * that is not a point in Bulgaria (the facilities_geom_in_bulgaria CHECK would
 * refuse it anyway — this turns a 500 into a message).
 */
export function parseLocation(
  lonRaw: FormDataEntryValue | null,
  latRaw: FormDataEntryValue | null,
): Point | null | 'invalid' {
  const lonText = String(lonRaw ?? '')
    .trim()
    .replace(',', '.');
  const latText = String(latRaw ?? '')
    .trim()
    .replace(',', '.');
  if (lonText === '' && latText === '') return null;
  const point = { lon: Number(lonText), lat: Number(latText) };
  if (lonText === '' || latText === '' || !insideBulgaria(point)) return 'invalid';
  return { lon: round6(point.lon), lat: round6(point.lat) };
}

/**
 * Did the operator actually move it? Compared at the precision the form shows,
 * so an untouched form — or the full-precision value pasted back in — is never
 * a move.
 */
export function locationChanged(current: Point, next: Point): boolean {
  return round6(current.lon) !== next.lon || round6(current.lat) !== next.lat;
}

import { distanceKm } from '@/lib/geo';

import type { MapBounds, MapPoint } from './map-canvas';

/**
 * The map list's rows: search, near-me radius and distance sort, all composing,
 * then a stable partition so whatever is CURRENTLY ON THE MAP leads the list
 * (operator request 2026-07-25) — pan to Варна and the thread starts with
 * Варна, while relative order within each half is untouched.
 *
 * Returns EVERY row that passes, uncapped, because this is also what the
 * header's count reports. The count used to print the size of the fetched set,
 * so typing «Борисова» showed two rows under «6060 съоръжения»; only the
 * rendered list is capped, by the caller.
 *
 * Pure, and free of React and MapLibre (`MapPoint` is a type-only import), so
 * the count the member reads can be tested in plain Node.
 */

export interface ListRow {
  point: MapPoint;
  /** Distance from the member, once they have located themselves. */
  km: number | null;
}

export interface ListQuery {
  /** What the member typed; trimmed and lower-cased here. */
  query: string;
  locale: string;
  /** The facility's lower-cased haystack (`facilitySearchText`). */
  searchText: (point: MapPoint) => string;
  userLocation: { lon: number; lat: number } | null;
  /** The near-me radius, or null while near-me is off. */
  radiusKm: number | null;
  /** The visible map, for the on-map-first partition; null before the first frame. */
  viewBounds: MapBounds | null;
}

export function matchRows(points: readonly MapPoint[], q: ListQuery): ListRow[] {
  const needle = q.query.trim().toLocaleLowerCase(q.locale);
  const from = q.userLocation;
  let rows: ListRow[] = points.map((point) => ({
    point,
    km: from ? distanceKm(from, { lon: point.lon, lat: point.lat }) : null,
  }));
  if (needle) rows = rows.filter((r) => q.searchText(r.point).includes(needle));
  const radius = q.radiusKm;
  if (radius !== null) rows = rows.filter((r) => r.km !== null && r.km <= radius);
  if (from) rows.sort((a, b) => (a.km ?? 0) - (b.km ?? 0));
  const b = q.viewBounds;
  if (b) {
    const visible = (p: MapPoint) =>
      p.lon >= b.west && p.lon <= b.east && p.lat >= b.south && p.lat <= b.north;
    rows = [...rows.filter((r) => visible(r.point)), ...rows.filter((r) => !visible(r.point))];
  }
  return rows;
}

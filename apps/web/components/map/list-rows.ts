import { transliterateBg } from '@sportkarta/lib/slug';

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
  /**
   * Inside the visible map. The rows that are come first, so the list can mark
   * where they end («Извън картата») and the count can say how many are on
   * screen. True for every row before the map has reported a frame.
   */
  onMap: boolean;
}

export interface ListQuery {
  /** What the member typed; trimmed, lower-cased and transliterated here. */
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

/**
 * What a search for `query` matches in a `facilitySearchText` haystack, or null
 * when there is nothing to search for.
 *
 * The needle is tried as typed AND transliterated, against a haystack that holds
 * both scripts: «sofia» finds «София» through the Latin half, while a Cyrillic
 * needle still matches the Cyrillic half directly — which matters mid-word,
 * where the transliteration of «Дия» (word-final «ия» → «ia») is not a prefix of
 * the transliteration of «Диян».
 */
export function searchMatcher(
  query: string,
  locale: string,
): ((haystack: string) => boolean) | null {
  const needle = query.trim().toLocaleLowerCase(locale);
  if (!needle) return null;
  const latin = transliterateBg(needle);
  return (haystack) => haystack.includes(needle) || haystack.includes(latin);
}

export function matchRows(points: readonly MapPoint[], q: ListQuery): ListRow[] {
  const from = q.userLocation;
  const match = searchMatcher(q.query, q.locale);
  const found = match ? points.filter((p) => match(q.searchText(p))) : points;
  let rows: ListRow[] = found.map((point) => ({
    point,
    km: from ? distanceKm(from, { lon: point.lon, lat: point.lat }) : null,
    onMap: true,
  }));
  const radius = q.radiusKm;
  if (radius !== null) rows = rows.filter((r) => r.km !== null && r.km <= radius);
  if (from) rows.sort((a, b) => (a.km ?? 0) - (b.km ?? 0));
  const b = q.viewBounds;
  if (b) {
    const visible = (p: MapPoint) =>
      p.lon >= b.west && p.lon <= b.east && p.lat >= b.south && p.lat <= b.north;
    rows = [
      ...rows.filter((r) => visible(r.point)),
      ...rows.filter((r) => !visible(r.point)).map((r) => ({ ...r, onMap: false })),
    ];
  }
  return rows;
}

/** How many rows lead the list from inside the visible map. */
export function countOnMap(rows: readonly ListRow[]): number {
  const firstOff = rows.findIndex((r) => !r.onMap);
  return firstOff === -1 ? rows.length : firstOff;
}

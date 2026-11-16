import { accessIncluding, filtersToSearchParams } from '@/lib/filters';

/**
 * The map, opened ON one facility — its pin in view and its card open, not the
 * country view.
 *
 * One builder, because the link has to agree with the map's own filters: the
 * map draws free places unless told otherwise, so a link to a place that is not
 * free carries the access selection that includes it (`accessIncluding`). A
 * free place gets the bare link it always had.
 *
 * Pure and client-safe: no database, no translations.
 */
export function facilityMapHref(facility: {
  slug: string;
  lat: number;
  lon: number;
  access: string;
}): string {
  const query = filtersToSearchParams({
    sports: [],
    surfaces: [],
    onlyLit: false,
    access: accessIncluding(facility.access),
  });
  query.set('selected', facility.slug);
  query.set('z', '16');
  query.set('lat', facility.lat.toFixed(5));
  query.set('lng', facility.lon.toFixed(5));
  return `/karta?${query.toString()}`;
}

/**
 * Until the front page existed, the map WAS "/": every shared link, every
 * bookmark and every search result for a filtered or focused map is of the
 * form `/?sport=…`, `/?selected=…&z=…`. Those links must keep opening the map.
 *
 * Any of the parameters the map has ever read from the address bar means the
 * visitor came for the map; the whole query string travels on unchanged (an
 * unknown parameter the map ignores costs nothing, and dropping one could break
 * a campaign tag). A bare "/" — or "/" with only parameters the map never read
 * — is the front page.
 */
const MAP_PARAMS = [
  'sport',
  'surface',
  'access',
  'lighting',
  'selected',
  'z',
  'lat',
  'lng',
  // The front page's "near me" hand-off. Printed QR codes point at `/?blizo=1`,
  // and a printed code can't be changed, so it has to keep opening the map.
  'blizo',
];

type SearchParams = Record<string, string | string[] | undefined>;

export function legacyMapHref(sp: SearchParams): string | null {
  if (!MAP_PARAMS.some((key) => sp[key] !== undefined)) return null;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) params.append(key, v);
  }
  return `/karta?${params.toString()}`;
}

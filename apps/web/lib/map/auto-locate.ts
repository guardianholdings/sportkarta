import type { UrlParams } from '@/lib/map/view';

/**
 * The flag the QR codes printed on facility stickers carry: `/?blizo=1`
 * ("nearby"). The stickers are one print run for every field, so a code cannot
 * name the place it is stuck on; the map finds it instead. It locates the
 * visitor once on arrival, through the same `locate()` as its locate button,
 * and the facility they are standing at heads the distance-sorted list without
 * a tap.
 *
 * Printed codes cannot be reissued: the name and the value are fixed for good.
 */
export const AUTO_LOCATE_PARAM = 'blizo';

/**
 * Whether this address asks the map to locate the visitor on arrival: the exact
 * value `1` and nothing else. A deep link to one facility (`?selected=…`) wins:
 * that visitor came for a named place, so the map opens on it and does not ask
 * where they are. An empty `selected=` names no facility, so it does not count.
 *
 * Pure, so the rule is tested on its own (tests/map-auto-locate.test.ts); the
 * explorer applies it once per page load.
 */
export function wantsAutoLocate(sp: UrlParams): boolean {
  const selected = sp.selected;
  const namesFacility = Array.isArray(selected)
    ? selected.some((slug) => slug !== '')
    : Boolean(selected);
  return sp[AUTO_LOCATE_PARAM] === '1' && !namesFacility;
}

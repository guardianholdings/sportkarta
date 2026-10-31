import { parseView } from './view';

/**
 * Where «Добави съоръжение» opens when the «+» is opened over /karta
 * (components/shell/quick-actions.tsx): the pin picker starts where the map is
 * looking, read from the address bar the explorer keeps current
 * (`?z=&lat=&lng=`, map-explorer.tsx `onMoveEnd`).
 *
 * Only from street zoom — the middle of a country-wide view is nowhere in
 * particular — and only as the VIEW (`izgled=1`): /dobavi then waits for the
 * member to place the pin, because an untouched pin is not a location
 * (components/map/pin-picker.tsx).
 */
export const ADD_FROM_VIEW_MIN_ZOOM = 13;

export function addFacilityHref(search: string): string {
  const view = parseView(Object.fromEntries(new URLSearchParams(search)));
  if (!view || view.zoom < ADD_FROM_VIEW_MIN_ZOOM) return '/dobavi';
  return `/dobavi?lon=${view.lng.toFixed(6)}&lat=${view.lat.toFixed(6)}&izgled=1`;
}

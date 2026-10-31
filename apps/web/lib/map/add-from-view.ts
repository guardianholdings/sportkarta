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
  const view = streetView(search);
  if (!view) return '/dobavi';
  return `/dobavi?lon=${view.lng.toFixed(6)}&lat=${view.lat.toFixed(6)}&izgled=1`;
}

/**
 * «Запиши тренировка» from the map: the training form, its place picker led by
 * the facilities around the view (trenirovki/page.tsx, `nearbyFacilities`).
 */
export function logTrainingHref(search: string): string {
  const view = streetView(search);
  if (!view) return '/trenirovki?nova=1';
  return `/trenirovki?nova=1&lon=${view.lng.toFixed(5)}&lat=${view.lat.toFixed(5)}`;
}

function streetView(search: string) {
  const view = parseView(Object.fromEntries(new URLSearchParams(search)));
  return view && view.zoom >= ADD_FROM_VIEW_MIN_ZOOM ? view : null;
}

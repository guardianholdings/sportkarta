/**
 * Turn-by-turn hand-off to the apps people in Bulgaria actually navigate with.
 *
 * WHY TWO, AND WHY NOT A MENU. Both surfaces that offer directions — the
 * facility page and the map sheet — render them as plain links, so the choice
 * is two taps' worth of markup rather than a popover: no JavaScript needed on
 * the facility page (which is the property the original single link was written
 * to keep), no focus trap to get wrong, and one tap instead of two on the phone
 * where somebody is standing in the street.
 *
 * WHY NOT OpenStreetMap ANY MORE. The map's own tiles are OSM and stay OSM —
 * this is only the hand-off. Operator decision 2026-08-11: openstreetmap.org's
 * routing page opens a website, not the navigation app already running on the
 * dashboard, and Waze and Google Maps are what drivers here have installed.
 *
 * The brand names are deliberately NOT in the i18n catalogue: "Waze" is Waze in
 * every locale. What IS translated is the accessible name around it
 * (`directionsWith` → «Упъти ме с Waze»), so a screen reader announces the
 * action and not a bare noun.
 */
export type NavProviderId = 'waze' | 'google';

export interface NavProvider {
  id: NavProviderId;
  /** Proper noun, same in every locale. */
  brand: string;
  href: (lat: number, lon: number) => string;
}

export const NAV_PROVIDERS: readonly NavProvider[] = [
  {
    id: 'waze',
    brand: 'Waze',
    // Waze's documented universal link: opens the installed app and starts
    // navigating, falls back to waze.com in a browser when it is absent.
    href: (lat, lon) => `https://waze.com/ul?ll=${String(lat)},${String(lon)}&navigate=yes`,
  },
  {
    id: 'google',
    brand: 'Google Maps',
    // Google's Maps URLs API. `api=1` is the stable, documented form and is
    // what makes iOS and Android open the app rather than the web page.
    href: (lat, lon) =>
      `https://www.google.com/maps/dir/?api=1&destination=${String(lat)},${String(lon)}`,
  },
];

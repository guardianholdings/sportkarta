import { cityDisplayName } from '../cities.js';
import { placeLabel } from '../geo/index.js';

/** What a mail needs to say where a game is — the columns @sportkarta/db's SessionPlace carries. */
export interface MailPlaceSource {
  facilityName: string | null;
  facilityQuarter: string | null;
  /** The municipality's Bulgarian name, as the facility row carries it. */
  facilityMunicipality: string | null;
}

/**
 * Where a game is, for a mail line that already names its sport — «Къде:
 * Лозенец, София — баскетбол», «18:00  Баскетбол 3×3 — баскетбол, Лозенец».
 *
 * The facility's own name, or else its area, or null when neither is known
 * (the template then says so in its own words). 91% of places have no name,
 * and the mails printed a blank there: «Къде:  — баскетбол». Not the site's
 * heading label «Баскетбол — Лозенец, София» (apps/web/lib/sessions/
 * place-name.ts): that leads with a sport, and the line already says which.
 *
 * The municipality is named the way the site names it — «Столична» reads
 * «София» — from the Bulgarian name the row carries; worker mail has no member
 * locale yet, so an English name is not looked up. `municipality: false` drops
 * it, for a mail about one city that already says which.
 */
export function mailPlace(
  place: MailPlaceSource,
  locale: string,
  options: { municipality?: boolean } = {},
): string | null {
  const name = place.facilityName?.trim();
  if (name) return name;
  const municipality =
    options.municipality === false || !place.facilityMunicipality
      ? null
      : cityDisplayName(place.facilityMunicipality, place.facilityMunicipality, locale);
  return placeLabel(place.facilityQuarter, municipality);
}

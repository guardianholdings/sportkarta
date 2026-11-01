import type { SessionPlace } from '@sportkarta/db';
import { getTranslations } from 'next-intl/server';

import { facilityTitle, type LabelStrings } from '@/components/map/facility-label';
import { municipalityDisplayName } from '@/lib/area-name';
import { placeLabel } from '@/lib/geo';

/**
 * Where a game is played, named the way the map names the place
 * (components/map/facility-label.ts): the facility's own name, or — for the 91%
 * OSM never named — its primary sport and its area, «Баскетбол — Лозенец,
 * София». The lists used to fall back to the GAME's sport, so a card titled
 * «Баскетбол 3×3» said «баскетбол» on its pin line and told nobody where to go.
 *
 * `municipality` arrives already named for the reader (municipalityDisplayName):
 * the row carries the Bulgarian name only, and the English site says "Sofia"
 * where the formal name is «Столична».
 */
export function sessionPlaceName(
  place: SessionPlace,
  municipality: string | null,
  labels: LabelStrings,
): string {
  return facilityTitle(
    {
      name: place.facilityName,
      sports: place.facilitySports,
      place: placeLabel(place.facilityQuarter, municipality),
    },
    labels,
  );
}

/**
 * The municipality named for the reader. The area is a nicety: if its name
 * cannot be resolved, the row's own Bulgarian name stands in rather than the
 * page failing.
 */
function readerMunicipality(nameBg: string, locale: string): Promise<string> {
  return municipalityDisplayName(nameBg, locale).catch(() => nameBg);
}

/**
 * The namer a page renders its games' places with. The strings and every
 * distinct municipality are resolved once per page, not once per card.
 */
export async function sessionPlaceNamer(
  places: readonly SessionPlace[],
  locale: string,
): Promise<(place: SessionPlace) => string> {
  const municipalities = [
    ...new Set(places.flatMap((p) => (p.facilityMunicipality ? [p.facilityMunicipality] : []))),
  ];
  const [tFacility, tSport, named] = await Promise.all([
    getTranslations({ locale, namespace: 'Facility' }),
    getTranslations({ locale, namespace: 'Sport' }),
    Promise.all(
      municipalities.map(
        async (nameBg) => [nameBg, await readerMunicipality(nameBg, locale)] as const,
      ),
    ),
  ]);
  const display = new Map(named);
  const labels: LabelStrings = {
    locale,
    unnamed: tFacility('unnamed'),
    sport: (sport) => tSport(sport),
    unnamedAt: (what, place) => tFacility('unnamedAt', { what, place }),
  };
  return (place) =>
    sessionPlaceName(
      place,
      place.facilityMunicipality
        ? (display.get(place.facilityMunicipality) ?? place.facilityMunicipality)
        : null,
      labels,
    );
}

/**
 * Where a game is, for a SENTENCE — «… в Лозенец, София»: the facility's own
 * name, or else its area; null when there is neither. The heading label leads
 * with the sport («Баскетбол — Лозенец, София»), which reads wrong after «в»,
 * and the game's title already says what is played.
 */
export async function sessionPlaceWhere(
  place: SessionPlace,
  locale: string,
): Promise<string | null> {
  const name = place.facilityName?.trim();
  if (name) return name;
  const municipality = place.facilityMunicipality
    ? await readerMunicipality(place.facilityMunicipality, locale)
    : null;
  return placeLabel(place.facilityQuarter, municipality);
}

/**
 * The place a facility share names.
 *
 * An unnamed facility's slug is its map ID (`way-313548695`). Until 2026-10-09
 * the share text fell back to it, and seven replies under an Instagram Reel
 * went out reading „way-313548695 — свободна спортна площадка в POPS.“ So the
 * share never uses the slug: it names the place the way the page it links to
 * names it in its heading (facilityTitle: the name, or the primary sport and
 * where it is), so the share and the page say the same thing.
 *
 * A comma rather than the heading's em dash between the sport and the place:
 * `textFacility` already puts an em dash after `{place}`, and two in one
 * sentence read as a list. The heading „Футбол — София“ is shared as
 * „Футбол, София — свободна спортна площадка в POPS.“
 */
import { facilityTitle, type LabelStrings } from '@/components/map/facility-label';
import { placeLabel } from '@/lib/geo';

export interface SharePlaceFacility {
  name: string | null;
  sportTypes: readonly string[];
  municipalityName: string | null;
  quarter: string | null;
}

export function facilitySharePlace(facility: SharePlaceFacility, labels: LabelStrings): string {
  return facilityTitle(
    {
      name: facility.name,
      sports: facility.sportTypes,
      place: placeLabel(facility.quarter, facility.municipalityName),
    },
    { ...labels, unnamedAt: (what, place) => `${what}, ${place}` },
  );
}

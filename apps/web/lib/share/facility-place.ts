/**
 * The place a facility share names.
 *
 * An unnamed facility's slug is its map ID (`way-313548695`). Until 2026-10-09
 * the share text fell back to it, and seven replies under an Instagram Reel
 * went out reading „way-313548695 — свободна спортна площадка в POPS.“ So the
 * share never uses the slug: it names an unnamed place the way the page itself
 * does (`Facility.unnamed`, „Спортно съоръжение“), followed by the
 * municipality, or the quarter when there is no municipality. That is what
 * tells two unnamed places apart in a thread of replies.
 *
 * A comma rather than the page title's em dash: `textFacility` already puts an
 * em dash after `{place}`, and two in one sentence read as a list.
 */
export interface SharePlaceFacility {
  name: string | null;
  municipalityName: string | null;
  quarter: string | null;
}

export function facilitySharePlace(facility: SharePlaceFacility, unnamed: string): string {
  const name = facility.name?.trim();
  if (name) return name;
  const area = facility.municipalityName?.trim() || facility.quarter?.trim();
  return area ? `${unnamed}, ${area}` : unnamed;
}

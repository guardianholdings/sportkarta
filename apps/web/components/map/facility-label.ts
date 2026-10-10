/**
 * What a facility is CALLED wherever the map shows it — the list card, the pin
 * preview, the pin's accessible name, the search index.
 *
 * WHY THIS EXISTS. 91% of the national corpus has no name (OSM rarely names a
 * pitch), and every surface used to fall back to the same generic noun. The
 * list became a column of identical «Спортно съоръжение» rows, the pins all
 * announced the same label to a screen reader, and name search could never find
 * an unnamed place at all. The list is the non-map alternative for keyboard and
 * screen-reader users, so rows nobody can tell apart made the map unusable
 * without sight of it.
 *
 * So an unnamed facility is described by what we DO know: its primary sport and
 * where it is — «Футбол — Лозенец, София». Nothing is invented; both halves are
 * data the row already carries.
 *
 * Pure and translator-agnostic: the caller passes its next-intl lookups in, so
 * this runs on the server (place pages) and in the client explorer alike, and
 * stays testable without a React tree.
 */

export interface LabelSource {
  name: string | null;
  sports: readonly string[];
  /** "Лозенец, София" — already composed by `placeLabel` (lib/geo.ts). */
  place?: string | null;
}

export interface LabelStrings {
  /** The UI locale, for capitalisation and case-insensitive search. */
  locale: string;
  /** Facility.unnamed — the last resort when there is neither sport nor place. */
  unnamed: string;
  /** Sport.<key> */
  sport: (sport: string) => string;
  /** Facility.unnamedAt — "{what} — {place}". */
  unnamedAt: (what: string, place: string) => string;
}

function capitalise(text: string, locale: string): string {
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** The heading: the facility's own name, or one built from its sport and place. */
export function facilityTitle(f: LabelSource, s: LabelStrings): string {
  const name = clean(f.name);
  if (name) return name;
  const primary = f.sports[0];
  // Sport labels are lower-case mid-sentence words ("футбол"); as a heading
  // they need the capital a name would have had.
  const what = primary ? capitalise(s.sport(primary), s.locale) : s.unnamed;
  const place = clean(f.place);
  return place ? s.unnamedAt(what, place) : what;
}

/**
 * The line under the heading: up to three sports, then — for a NAMED facility —
 * where it is.
 *
 * An unnamed facility's title is already built from its primary sport and its
 * place («Тенис — Лозенец, София»), so neither is repeated here: its line lists
 * only the OTHER sports, or is empty. Repeating the primary sport printed
 * «Тенис» over «тенис» on every unnamed single-sport row — most of the list —
 * and spent the card's only spare line on nothing (UX audit 2026-10-10).
 */
export function facilitySubtitle(f: LabelSource, s: LabelStrings): string {
  const named = clean(f.name) !== null;
  const sports = f.sports
    .slice(named ? 0 : 1, named ? 3 : 4)
    .map((sport) => s.sport(sport))
    .join(' · ');
  const place = named ? clean(f.place) : null;
  return [sports, place].filter(Boolean).join(' — ');
}

/**
 * Everything a search for this facility may match, lower-cased once. The field
 * promises "place or activity", so the sports and the place are in it — which is
 * also the only way an unnamed facility can be found by typing.
 */
export function facilitySearchText(f: LabelSource, s: LabelStrings): string {
  return [facilityTitle(f, s), ...f.sports.map((sport) => s.sport(sport)), clean(f.place) ?? '']
    .join(' ')
    .toLocaleLowerCase(s.locale);
}

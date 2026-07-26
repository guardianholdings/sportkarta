import { BULGARIA_BBOX, insideBulgaria } from '../geo/index.js';
import { CANONICAL_SPORTS, CANONICAL_SURFACES, type CanonicalSport } from '../sports.js';

/**
 * Normalising one row of a municipal registry CSV (docs/ROADMAP.md §8, Stage
 * 6.3). Pure — no database — so it is property-testable and the same rules run
 * in the preview and at commit.
 *
 * A municipal registry is a spreadsheet a person in a mayor's office maintained
 * by hand, so this is forgiving where it safely can be — Bulgarian OR English
 * enum values, a sports column that is a list in either language, lighting as
 * "да"/"yes"/"1" — and unforgiving where it must be: a facility has a NOT NULL
 * geom, so a row without valid Bulgarian coordinates cannot be placed on a map
 * and is rejected with a reason rather than guessed at. Geocoding an address is
 * deliberately out of scope; a row is a point or it is nothing.
 *
 * The validation vocabulary is the SAME as the crowd add-facility flow
 * (CANONICAL_SPORTS, the access enum, CANONICAL_SURFACES): a municipal import
 * must not be able to write a value a resident could not, or the two provenance
 * layers would disagree about what a valid facility looks like.
 */

/** The access enum, mirrored from the facilities schema. */
export type AccessValue = 'free' | 'paid' | 'restricted' | 'school';

/** Bulgarian synonyms an operator is likely to type for each access value. */
const ACCESS_ALIASES: Record<string, AccessValue> = {
  free: 'free',
  свободен: 'free',
  безплатен: 'free',
  'свободен достъп': 'free',
  paid: 'paid',
  платен: 'paid',
  restricted: 'restricted',
  ограничен: 'restricted',
  'с ограничен достъп': 'restricted',
  school: 'school',
  училищен: 'school',
  училище: 'school',
};

/**
 * Bulgarian names for each canonical sport — the Sport display catalogue's
 * values plus the spellings a municipal registry actually writes. The access
 * and lighting columns already read Bulgarian; the sports column was the one
 * a Bulgarian registry will ALWAYS write in Bulgarian and the only one that
 * refused it. Aliases are deliberately unambiguous: a word that could mean
 * two sports (or none) is left out, because an unknown token errors visibly
 * per row while a wrong alias rewrites the map silently.
 */
const SPORT_ALIASES: Record<string, CanonicalSport> = {
  'стрелба с лък': 'archery',
  'лека атлетика': 'athletics',
  атлетика: 'athletics',
  бадминтон: 'badminton',
  баскетбол: 'basketball',
  'плажен волейбол': 'beach_volleyball',
  бмх: 'bmx',
  'стрийт фитнес': 'calisthenics',
  калистеника: 'calisthenics',
  шахмат: 'chess',
  шах: 'chess',
  катерене: 'climbing',
  колоездене: 'cycling',
  'конен спорт': 'equestrian',
  езда: 'equestrian',
  фитнес: 'fitness',
  футбол: 'football',
  'мини футбол': 'football',
  гимнастика: 'gymnastics',
  хандбал: 'handball',
  'пешеходен туризъм': 'hiking',
  туризъм: 'hiking',
  хокей: 'hockey',
  кънки: 'ice_skating',
  'ледена пързалка': 'ice_skating',
  'бойни изкуства': 'martial_arts',
  мултиспорт: 'multi',
  многофункционална: 'multi',
  многофункционално: 'multi',
  петанк: 'petanque',
  бягане: 'running',
  'спортна стрелба': 'shooting',
  стрелба: 'shooting',
  скейтборд: 'skateboard',
  скейт: 'skateboard',
  скейтпарк: 'skateboard',
  'скейт парк': 'skateboard',
  скуош: 'squash',
  плуване: 'swimming',
  басейн: 'swimming',
  'тенис на маса': 'table_tennis',
  'пинг понг': 'table_tennis',
  'пинг-понг': 'table_tennis',
  тенис: 'tennis',
  волейбол: 'volleyball',
};

const NAME_MAX = 200;
const QUARTER_MAX = 120;

/** Matches the facilities_geom_in_bulgaria CHECK, so a pass here never aborts. */
// Re-exported from lib/src/geo so this module keeps its public name while
// there stays exactly ONE definition of where Bulgaria is.
export { BULGARIA_BBOX };

/** The fields a municipal CSV column can be mapped to. */
export const MUNICIPAL_FIELDS = [
  'name',
  'sport',
  'access',
  'surface',
  'lighting',
  'covered',
  'quarter',
  'lon',
  'lat',
] as const;
export type MunicipalField = (typeof MUNICIPAL_FIELDS)[number];

/** One row's raw cell values, keyed by field. Everything is a trimmed string. */
export type RawRow = Partial<Record<MunicipalField, string>> & { rowNumber: number };

/**
 * The managed field values a valid row contributes. These are exactly the keys
 * mergeFields operates over and facility_edits records — no more, so a municipal
 * import cannot reach a column the merge policy does not govern (status,
 * condition and the OSM ref are all deliberately absent).
 */
export interface NormalizedRow {
  rowNumber: number;
  name: string | null;
  sportTypes: string[];
  access: AccessValue;
  surface: string | null;
  lighting: boolean | null;
  covered: boolean;
  quarter: string | null;
  lon: number;
  lat: number;
}

export interface RowError {
  rowNumber: number;
  /** i18n slug under AdminMunicipalImport.rowError.*. */
  code: string;
}

export type NormalizeOutcome =
  | { ok: true; row: NormalizedRow }
  | { ok: false; error: RowError };

function cleanText(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * Split a sports cell on commas, semicolons or slashes, then canonicalise each
 * token through SPORT_ALIASES. A token that is neither an alias nor already
 * canonical passes through unchanged so normalizeRow can reject it with the
 * row's own error.
 */
function splitSports(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,;/]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    // hasOwn, not plain indexing: a cell token like "__proto__" or "toString"
    // must fall through to invalid_sport, not resolve an inherited property.
    .map((s) => (Object.hasOwn(SPORT_ALIASES, s) ? (SPORT_ALIASES[s] ?? s) : s));
}

const TRUE_WORDS = new Set(['да', 'yes', 'true', '1', 'y', 'истина', 'има']);
const FALSE_WORDS = new Set(['не', 'no', 'false', '0', 'n', 'няма']);

/**
 * Tri-state boolean. An EMPTY cell is `null` (unknown), which is not the same
 * as `false`: "we do not know whether this pitch is lit" must not be recorded
 * as "this pitch is not lit". An unrecognised WORD, though, is an error — it
 * means the column was mapped wrong, and silently reading it as unknown would
 * hide that from the operator.
 */
function parseTriState(value: string | undefined): boolean | null | 'invalid' {
  const text = (value ?? '').trim().toLowerCase();
  if (text === '') return null;
  if (TRUE_WORDS.has(text)) return true;
  if (FALSE_WORDS.has(text)) return false;
  return 'invalid';
}

/** A required boolean (covered): empty means false, an unknown word is an error. */
function parseBool(value: string | undefined): boolean | 'invalid' {
  const state = parseTriState(value);
  if (state === 'invalid') return 'invalid';
  return state === true;
}

function parseCoordinate(value: string | undefined): number | null {
  const text = (value ?? '').trim().replace(',', '.');
  if (text === '') return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

export function normalizeRow(raw: RawRow): NormalizeOutcome {
  const fail = (code: string): NormalizeOutcome => ({
    ok: false,
    error: { rowNumber: raw.rowNumber, code },
  });

  const name = cleanText(raw.name);
  if (name.length > NAME_MAX) return fail('name_too_long');

  const quarter = cleanText(raw.quarter);
  if (quarter.length > QUARTER_MAX) return fail('quarter_too_long');

  // Sports: unknown ones are rejected rather than dropped, so a column mapped to
  // the wrong field surfaces as an error instead of an empty list. An empty
  // sports cell IS allowed — a municipal registry may list a multi-use ground.
  const rawSports = splitSports(raw.sport);
  const sportTypes = [...new Set(rawSports)];
  if (sportTypes.some((s) => !(CANONICAL_SPORTS as readonly string[]).includes(s))) {
    return fail('invalid_sport');
  }

  // Access is REQUIRED (the column is NOT NULL and has no sane default — a
  // registry that does not state access has not been mapped correctly).
  const accessRaw = cleanText(raw.access).toLowerCase();
  if (accessRaw === '') return fail('access_required');
  const access = ACCESS_ALIASES[accessRaw];
  if (!access) return fail('invalid_access');

  const surface: string | null = cleanText(raw.surface).toLowerCase() || null;
  if (surface && !(CANONICAL_SURFACES as readonly string[]).includes(surface)) {
    return fail('invalid_surface');
  }

  const lighting = parseTriState(raw.lighting);
  if (lighting === 'invalid') return fail('invalid_lighting');

  const covered = parseBool(raw.covered);
  if (covered === 'invalid') return fail('invalid_covered');

  const lon = parseCoordinate(raw.lon);
  const lat = parseCoordinate(raw.lat);
  if (lon === null || lat === null) return fail('coordinates_required');
  if (!insideBulgaria({ lon, lat })) return fail('outside_bulgaria');

  return {
    ok: true,
    row: {
      rowNumber: raw.rowNumber,
      name: name || null,
      // Preserve canonical order so a re-import produces an identical array and
      // mergeFields sees it as unchanged (jsonEquals is array-order sensitive).
      sportTypes: CANONICAL_SPORTS.filter((s) => sportTypes.includes(s)),
      access,
      surface,
      lighting,
      covered,
      quarter: quarter || null,
      // Six decimals ≈ 0.1 m — precise enough for a pitch, and stable across
      // re-imports so the geom never counts as "changed" on the second upload.
      lon: Number(lon.toFixed(6)),
      lat: Number(lat.toFixed(6)),
    },
  };
}

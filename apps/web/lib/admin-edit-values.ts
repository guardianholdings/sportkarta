import { formatCoordinate } from './facility-editor';

/**
 * One side of a `facility_edits` row, in words rather than JSON — the crowd-edit
 * feed (/admin/redakcii) and the editor's own change history (/admin/facilities/
 * [id]) both print edits, and the editor used to print them raw:
 * `sport_types: ["football"]`, a location as `{"lon":23.32,"lat":42.69}`, a
 * municipality as a bare id (UX audit 2026-10-10, A-14). Pure; the caller hands
 * in the vocabulary from its own translators.
 */
export interface EditValueWords {
  none: string;
  yes: string;
  no: string;
  access: (value: string) => string;
  status: (value: string) => string;
  surface: (value: string) => string;
  condition: (value: string) => string;
  sport: (value: string) => string;
  /** A municipality's name by id, when the caller has the list at hand. */
  municipality?: (id: number) => string | undefined;
}

function isPoint(value: unknown): value is { lon: number; lat: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { lon?: unknown }).lon === 'number' &&
    typeof (value as { lat?: unknown }).lat === 'number'
  );
}

export function describeEditValue(field: string, value: unknown, words: EditValueWords): string {
  if (value === null || value === undefined) return words.none;
  if (typeof value === 'boolean') return value ? words.yes : words.no;
  if (typeof value === 'string') {
    if (field === 'access' || field === 'access_proposed') return words.access(value);
    if (field === 'status') return words.status(value);
    if (field === 'surface') return words.surface(value);
    if (field === 'condition') return words.condition(value);
    return value;
  }
  if (Array.isArray(value) && field === 'sport_types') {
    return value.length === 0
      ? words.none
      : value.map((sport) => words.sport(String(sport))).join(', ');
  }
  // Latitude first, as a map app takes it; the six decimals the editor shows.
  if (field === 'geom' && isPoint(value)) {
    return `${formatCoordinate(value.lat)}, ${formatCoordinate(value.lon)}`;
  }
  if (field === 'municipality_id' && typeof value === 'number') {
    return words.municipality?.(value) ?? String(value);
  }
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}

/** Edits that changed no column: only the field's name says anything. */
export function isMarkerEdit(field: string): boolean {
  return field === 'created' || field === 'verified' || field === 'reported_missing';
}

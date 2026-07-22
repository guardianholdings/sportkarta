/**
 * Field-level merge policy (docs/ROADMAP.md §3): crowd > municipal > osm.
 *
 * A facility field whose LAST facility_edits entry came from a
 * higher-priority source is frozen against lower-priority overwrites —
 * an OSM re-import can never clobber a crowd-verified value. Pure code so
 * the importer (Stage 1), contribution flows (Stage 3) and the municipal
 * inbox (Stage 6) all share one implementation, and so it is property-testable
 * without a database.
 */

export type EditSource = 'osm' | 'municipal' | 'crowd';

export const SOURCE_PRIORITY: Record<EditSource, number> = {
  osm: 1,
  municipal: 2,
  crowd: 3,
};

/** JSON value as stored in facility_edits.old_value/new_value (jsonb). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/**
 * May `incoming` overwrite a field whose last audited edit came from
 * `lastEditSource`? Never-edited fields (undefined) are always writable;
 * equal priority may overwrite (a source may revise its own data).
 */
export function canOverwrite(
  incoming: EditSource,
  lastEditSource: EditSource | undefined,
): boolean {
  if (lastEditSource === undefined) return true;
  return SOURCE_PRIORITY[incoming] >= SOURCE_PRIORITY[lastEditSource];
}

/** Deep structural equality for JSON values (object key order insensitive). */
export function jsonEquals(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEquals(v, b[i] as JsonValue));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in b && jsonEquals(a[k], b[k]));
  }
  return false;
}

export interface MergeInput {
  incomingSource: EditSource;
  /** Current field values on the facility row. */
  current: Record<string, JsonValue>;
  /** Proposed new values; only these fields are considered. */
  incoming: Record<string, JsonValue>;
  /** Source of the LAST facility_edits entry per field (absent = never edited). */
  lastEditSources: Record<string, EditSource | undefined>;
}

export interface FieldChange {
  field: string;
  oldValue: JsonValue;
  newValue: JsonValue;
}

export interface MergeResult {
  /** Changes to apply — each MUST produce one facility_edits audit row. */
  applied: FieldChange[];
  /** Fields skipped because a higher-priority source last set them. */
  frozen: string[];
  /** Fields whose incoming value equals the current one — no write, no audit. */
  unchanged: string[];
}

/**
 * Partition incoming fields into applied / frozen / unchanged.
 * Unchanged wins over frozen: an identical value is a no-op regardless of
 * who set it, which is what makes repeated imports idempotent.
 */
export function mergeFields(input: MergeInput): MergeResult {
  const applied: FieldChange[] = [];
  const frozen: string[] = [];
  const unchanged: string[] = [];

  for (const [field, newValue] of Object.entries(input.incoming)) {
    const oldValue = input.current[field] ?? null;
    if (jsonEquals(oldValue, newValue)) {
      unchanged.push(field);
    } else if (!canOverwrite(input.incomingSource, input.lastEditSources[field])) {
      frozen.push(field);
    } else {
      applied.push({ field, oldValue, newValue });
    }
  }

  return { applied, frozen, unchanged };
}

import {
  ALLOWED_RELATIONS,
  assertSafeFragment,
  deniedTokensIn,
  EXPORT_DATASETS,
  relationsIn,
  type ExportDataset,
} from '@sportkarta/lib/opendata';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Compiling a catalogue entry into the one query that produces it (Stage 6.1).
 *
 * THE SELECT LIST IS GENERATED FROM THE DECLARED FIELDS. That single sentence
 * is the security property of this stage. There is no code path here that can
 * emit `SELECT *`, no path that can add a column the catalogue does not name,
 * and no path that can rename one — every output column is `<field.sql> AS
 * "<field.name>"`, built by iterating `dataset.fields`. A column that is not in
 * lib/src/opendata/schema.ts cannot be exported, whatever anybody writes here
 * later, because there is nowhere to write it.
 *
 * ON `sql.raw`. The fragments interpolated below are compile-time constants
 * from a closed catalogue; no request value reaches them (the only thing a
 * caller supplies is a dataset id, which is matched against the catalogue, and
 * a numeric limit, which is bound as a parameter). That is an argument, not a
 * proof, so it is backed by checks that run whether or not anybody believes it:
 *
 *   - Every fragment passes `assertSafeFragment` — no semicolon, no comment
 *     opener, no character outside a narrow allowlist.
 *   - Every relation named in a FROM clause must be on ALLOWED_RELATIONS.
 *   - Nothing may contain a person-bearing token (the same matcher the PII
 *     denylist test uses, so the runtime and the test cannot disagree).
 *
 * ...and they run at MODULE LOAD, not per request. A catalogue that would
 * compile to an unsafe query takes the process down on boot, in CI, in front of
 * whoever is deploying — rather than failing on one endpoint at 3 a.m., or
 * worse, succeeding.
 */

function assertDatasetSafe(dataset: ExportDataset): void {
  const where = `dataset ${dataset.id}`;

  for (const clause of [dataset.from, dataset.orderBy, dataset.where ?? '']) {
    if (clause) assertSafeFragment(clause, where);
  }

  const relations = relationsIn(dataset.from);
  if (relations.length === 0) {
    throw new Error(`opendata: ${where} names no relation`);
  }
  for (const relation of relations) {
    if (!(ALLOWED_RELATIONS as readonly string[]).includes(relation)) {
      throw new Error(`opendata: ${where} reads non-allowlisted relation "${relation}"`);
    }
  }

  if (dataset.fields.length === 0) {
    throw new Error(`opendata: ${where} declares no fields`);
  }
  for (const field of dataset.fields) {
    assertSafeFragment(field.sql, `${where}.${field.name}`);
    // A quoted identifier is what makes `AS "<name>"` safe; a name that could
    // contain a quote could close it. Field names are an API anyway, so the
    // shape rule costs nothing.
    if (!/^[a-z][a-z0-9_]*$/.test(field.name)) {
      throw new Error(`opendata: ${where}.${field.name} is not a plain identifier`);
    }
    if (field.sql.includes('*')) {
      throw new Error(`opendata: ${where}.${field.name} selects a star`);
    }
  }

  const dirty = [
    ...deniedTokensIn(dataset.from),
    ...deniedTokensIn(dataset.where ?? ''),
    ...deniedTokensIn(dataset.orderBy),
    ...dataset.fields.flatMap((f) => [...deniedTokensIn(f.name), ...deniedTokensIn(f.sql)]),
  ];
  if (dirty.length > 0) {
    throw new Error(`opendata: ${where} names person-bearing identifiers: ${dirty.join(', ')}`);
  }
}

// Boot-time gate over the whole catalogue (see the header).
for (const dataset of EXPORT_DATASETS) assertDatasetSafe(dataset);

export interface ExportQueryOptions {
  /**
   * Row cap. Bound as a parameter, never interpolated. The API applies one so a
   * single request cannot ask for an unbounded scan; the nightly dump does not,
   * because a truncated bulk download is worse than a slow one — a consumer
   * cannot tell a capped file from a shrinking dataset.
   */
  limit?: number;
}

/** The SQL for one dataset: every declared field, aliased to its declared name. */
export function exportQuery(dataset: ExportDataset, options: ExportQueryOptions = {}): SQL {
  const columns = sql.join(
    dataset.fields.map((field) => sql`${sql.raw(field.sql)} AS ${sql.raw(`"${field.name}"`)}`),
    sql`, `,
  );
  const where = dataset.where ? sql` WHERE ${sql.raw(dataset.where)}` : sql``;
  const limit =
    options.limit === undefined ? sql`` : sql` LIMIT ${Math.max(0, Math.floor(options.limit))}`;
  return sql`SELECT ${columns} FROM ${sql.raw(dataset.from)}${where} ORDER BY ${sql.raw(
    dataset.orderBy,
  )}${limit}`;
}

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Run one dataset and return its rows, keyed by the declared field names. */
export async function runExport(
  db: SqlRunner,
  dataset: ExportDataset,
  options: ExportQueryOptions = {},
): Promise<Record<string, unknown>[]> {
  const result = await db.execute(exportQuery(dataset, options));
  return result.rows;
}

export { assertDatasetSafe };

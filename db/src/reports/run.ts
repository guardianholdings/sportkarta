import {
  allMetrics,
  allTables,
  assertKnownPlaceholders,
  assertSafeReportSql,
  placeholdersIn,
  type ReportData,
  type ReportDefinition,
  type ReportScope,
} from '@sportkarta/lib/reports';
import type pg from 'pg';

/**
 * Running a report catalogue against the database (Stage 6.2).
 *
 * THE SCOPE IS BOUND, NEVER INTERPOLATED. A metric's SQL is a compile-time
 * constant containing `:from`, `:to` and `:municipality`; this module rewrites
 * those to `$1..$n` and passes the values as driver parameters. The only thing
 * a caller supplies is three values and a definition that must already be in
 * the catalogue — no request text reaches a query.
 *
 * Backed by checks that run at MODULE LOAD rather than per request, so a
 * catalogue that would compile to something unsafe takes the process down on
 * boot, in CI, in front of whoever is deploying — rather than failing on one
 * endpoint the first time a grant deadline is near.
 *
 * THE WINDOW IS HALF-OPEN: `from` inclusive, `to` exclusive. `starts_at < :to`
 * with an exclusive bound includes the last day's final microsecond without the
 * query having to know the column's precision; `<=` against an inclusive
 * midnight would silently drop anything after 00:00:00.000000 on that day. The
 * renderer prints the day BEFORE `to` so the reader sees an inclusive range,
 * because the off-by-one otherwise lands in a document somebody signs.
 */

function compile(sql: string, where: string): { text: string; order: string[] } {
  assertSafeReportSql(sql, where);
  assertKnownPlaceholders(sql, where);

  const order: string[] = [];
  // Same negative lookbehind as placeholdersIn: `::int` is a cast, not a
  // placeholder, and treating it as one would break every cast in the
  // catalogue while looking like a parameter-binding bug.
  const text = sql.replace(/(?<![:\w]):([a-z_]+)/g, (_match, name: string) => {
    let index = order.indexOf(name);
    if (index === -1) {
      order.push(name);
      index = order.length - 1;
    }
    return `$${String(index + 1)}`;
  });
  return { text, order };
}

/** Boot-time gate over both catalogues. */
export function assertReportSafe(definition: ReportDefinition): void {
  for (const { metric } of allMetrics(definition)) {
    compile(metric.sql, `${definition.id}.${metric.id}`);
    if (!metric.labelBg.trim()) {
      throw new Error(`reports: ${definition.id}.${metric.id} has no Bulgarian label`);
    }
  }
  for (const { table } of allTables(definition)) {
    compile(table.sql, `${definition.id}.${table.id}`);
    if (table.columns.length !== table.columnsBg.length) {
      throw new Error(`reports: ${definition.id}.${table.id} column count mismatch`);
    }
  }
}

export interface RunScope {
  /** Inclusive start. */
  from: Date;
  /** EXCLUSIVE end. */
  to: Date;
  /** Municipality id, or null for the national scope. */
  municipalityId: number | null;
}

interface Queryable {
  query(config: { text: string; values: unknown[] }): Promise<{ rows: Record<string, unknown>[] }>;
}

function valuesFor(order: string[], scope: RunScope): unknown[] {
  return order.map((name) => {
    if (name === 'from') return scope.from;
    if (name === 'to') return scope.to;
    return scope.municipalityId;
  });
}

/**
 * The compiled SQL for one metric, with its parameter order — exported so the
 * reconciliation tests can run the exact text the report runs rather than a
 * paraphrase of it.
 */
export function compileMetric(
  definition: ReportDefinition,
  metricId: string,
): { text: string; order: string[] } {
  const found = allMetrics(definition).find(({ metric }) => metric.id === metricId);
  if (!found) throw new Error(`reports: no metric ${definition.id}.${metricId}`);
  return compile(found.metric.sql, `${definition.id}.${metricId}`);
}

export async function runReport(
  client: Queryable,
  definition: ReportDefinition,
  scope: RunScope,
  municipalityNameBg: string | null,
  now: Date = new Date(),
): Promise<ReportData> {
  const metrics = [];
  for (const { metric } of allMetrics(definition)) {
    const { text, order } = compile(metric.sql, `${definition.id}.${metric.id}`);
    const result = await client.query({ text, values: valuesFor(order, scope) });
    const raw = result.rows[0]?.value;
    // NULL and "no row" both mean "not measured" and stay null all the way to
    // the renderer, which prints them as an em dash. Coercing either to 0 would
    // report an absence of data as a measured zero — in a document a funder
    // reads as a claim about what happened.
    metrics.push({
      metricId: metric.id,
      value: raw === null || raw === undefined ? null : Number(raw),
    });
  }

  const tables = [];
  for (const { table } of allTables(definition)) {
    const { text, order } = compile(table.sql, `${definition.id}.${table.id}`);
    const result = await client.query({ text, values: valuesFor(order, scope) });
    tables.push({ tableId: table.id, rows: result.rows });
  }

  const reportScope: ReportScope = {
    from: scope.from.toISOString(),
    to: scope.to.toISOString(),
    municipalityNameBg,
    generatedAt: now.toISOString(),
  };

  return { scope: reportScope, metrics, tables };
}

/** Adapter so a drizzle-owning caller can pass a plain `pg` pool or client. */
export function asQueryable(client: pg.ClientBase | pg.Pool): Queryable {
  return {
    query: async (config) => {
      const result = await client.query(config.text, config.values);
      return { rows: result.rows as Record<string, unknown>[] };
    },
  };
}

export { placeholdersIn };

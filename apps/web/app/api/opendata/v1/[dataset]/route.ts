import { getDb, runExport } from '@sportkarta/db';
import {
  datasetById,
  serializeCsv,
  serializeGeoJSON,
  serializeJson,
  type ExportFormat,
} from '@sportkarta/lib/opendata';

import {
  openDataContext,
  openDataError,
  openDataJson,
  openDataOptions,
  openDataText,
  tooManyRequests,
} from '@/lib/opendata/response';

/**
 * The documented open-data API (Stage 6.1).
 *
 * ONE ROUTE FOR EVERY DATASET, resolved from the catalogue by URL segment. That
 * is the same decision as everywhere else in this stage: a new dataset is an
 * entry in lib/src/opendata/schema.ts and nothing else — no new file, no new
 * handler to forget the licence headers or the rate limit on. Four handlers
 * would be four places for those to drift.
 *
 * DELIBERATELY SEPARATE FROM /api/facilities. That endpoint feeds our own map
 * and is free to change shape whenever the map does. This one is versioned in
 * its path and is what a municipality's dashboard is invited to depend on;
 * collapsing them would mean either freezing the map's feed or breaking
 * somebody's dashboard to move a marker.
 *
 * The response is identical with or without a key (a key buys throughput, not
 * data), so it is publicly cacheable and does not vary on Authorization.
 */

export const dynamic = 'force-dynamic';

/**
 * Safety bound, not a page size. It sits comfortably above the ~6.6k national
 * corpus so no real request is truncated today, and it exists so that a corpus
 * which grows tenfold does not turn one request into an unbounded scan. When it
 * ever does bite, the response says so in `truncated` rather than quietly
 * serving a short file — a consumer cannot otherwise tell a capped download
 * from a dataset that shrank.
 */
const MAX_ROWS = 25_000;

function parseFormat(requested: string | null, dataset: { formats: readonly ExportFormat[] }) {
  const fallback = dataset.formats[0];
  if (!requested) return fallback;
  return dataset.formats.includes(requested as ExportFormat)
    ? (requested as ExportFormat)
    : undefined;
}

function parseLimit(raw: string | null): number {
  if (!raw) return MAX_ROWS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return MAX_ROWS;
  return Math.min(Math.floor(value), MAX_ROWS);
}

export function OPTIONS() {
  return openDataOptions();
}

export async function GET(request: Request, { params }: { params: Promise<{ dataset: string }> }) {
  const context = await openDataContext(request);
  if (!context.decision.allowed) return tooManyRequests(context);

  const { dataset: id } = await params;
  const dataset = datasetById(id);
  if (!dataset) {
    return openDataError(
      404,
      'unknown_dataset',
      `No dataset "${id}". See the documentation for the list.`,
      context,
    );
  }

  const url = new URL(request.url);
  const format = parseFormat(url.searchParams.get('format'), dataset);
  if (!format) {
    return openDataError(
      400,
      'unsupported_format',
      `Dataset "${dataset.id}" is available as: ${dataset.formats.join(', ')}.`,
      context,
    );
  }

  const limit = parseLimit(url.searchParams.get('limit'));
  const rows = await runExport(getDb(), dataset, { limit });
  const truncated = rows.length >= MAX_ROWS;

  if (format === 'csv') {
    return openDataText(
      serializeCsv(dataset, rows),
      context,
      'text/csv; charset=utf-8',
      `${dataset.id}.csv`,
    );
  }

  if (format === 'geojson') {
    return openDataJson(
      { ...serializeGeoJSON(dataset, rows), row_count: rows.length, truncated },
      context,
      'application/geo+json; charset=utf-8',
    );
  }

  return openDataJson(
    { ...serializeJson(dataset, rows), row_count: rows.length, truncated },
    context,
  );
}

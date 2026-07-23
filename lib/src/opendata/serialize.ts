/**
 * Serializers for the open-data exports (Stage 6.1).
 *
 * Driven entirely by the catalogue: a serializer is handed a dataset and a
 * sequence of rows and emits only the fields the dataset declares, in the
 * declared order. It never enumerates the keys of a row. That is deliberate —
 * `Object.keys(row)` would faithfully publish any column a hand-edited query
 * happened to select, which is the exact hole the catalogue exists to close.
 *
 * The CSV writing itself is lib/src/csv.ts's `toCsv`, not a second
 * implementation here: it already does RFC 4180 quoting and already prefixes
 * cells a spreadsheet would execute as a formula (its own header names Stage
 * 6's dumps as a caller). A separate quoter in this file would be the copy that
 * eventually diverges, and the one that diverges is always the one facing the
 * public.
 *
 * NOTE the coupling that creates: `toCsv` treats a leading `-` as a formula
 * leader and prefixes it with an apostrophe. That is correct for text and wrong
 * for a negative number — and it is safe here only because no numeric field in
 * the catalogue can BE negative: every one is a count, a non-negative ratio, or
 * a Bulgarian coordinate (longitude ~22..28, latitude ~41..44). A future field
 * that can go below zero needs this revisited, not ignored.
 *
 * WHERE THE ATTRIBUTION GOES, AND WHERE IT DELIBERATELY DOES NOT. GeoJSON and
 * JSON carry `license` and `attribution` as members, because those formats have
 * somewhere to put them. CSV does NOT: a `# © OpenStreetMap contributors` line
 * above the header is not CSV, and every parser that meets one either fails or
 * silently reads the licence as a column name. So for CSV the attribution
 * travels out-of-band and in three places instead — the `Link: rel="license"`
 * header on the API response, a LICENSE.txt beside the file in every dump
 * version, and the manifest entry. An unparseable file with a licence inside is
 * worse for compliance than a clean file with the licence next to it, because
 * nobody redistributes the first one at all.
 *
 * Pure and dependency-free.
 */

import { toCsv } from '../csv.js';

import type { ExportDataset, ExportField } from './schema.js';
import { OPEN_DATA_LICENSE } from './schema.js';

export type ExportRow = Record<string, unknown>;

/** Bytes Excel needs to read UTF-8 — Cyrillic is mojibake without them. */
const BOM = '﻿';

/**
 * Coordinate precision. Six decimals is ~11 cm at this latitude, which is
 * already finer than anything in the corpus: an OSM node is hand-placed and a
 * crowd pin comes from a phone's GPS. Emitting the float's full 15 digits would
 * dress a ±5 m guess up as a survey, and somebody would eventually build a
 * distance calculation on the implied accuracy.
 */
const COORDINATE_DECIMALS = 6;

function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

/**
 * One row's value for one declared field, normalised by the field's TYPE rather
 * than by whatever the driver happened to hand back. The driver's shape varies
 * with the column (numeric arrives as a string, timestamptz as a Date), and an
 * export whose formatting depends on driver behaviour changes the day somebody
 * upgrades `pg`.
 */
export function fieldValue(field: ExportField, row: ExportRow): unknown {
  const raw = row[field.name];
  if (raw === null || raw === undefined) return null;
  switch (field.type) {
    case 'boolean':
      return Boolean(raw);
    case 'integer':
    case 'number':
      return Number(raw);
    case 'coordinate':
      return Number(Number(raw).toFixed(COORDINATE_DECIMALS));
    case 'timestamp':
      return isoTimestamp(raw);
    case 'enum_list':
      return Array.isArray(raw) ? raw.map(String) : [];
    case 'string':
    case 'enum':
      return String(raw);
  }
}

/**
 * A value as one CSV cell. NULL becomes the empty field — not "null", not
 * "N/A": an empty field is what every parser reads back as missing, and
 * `population` being unknown for a municipality has to survive the round trip
 * as unknown rather than as a string somebody later parses to zero.
 *
 * `enum_list` joins on `;` rather than `,`: inside a comma-delimited file that
 * avoids quoting a whole column, and our own delimiter detection counts only
 * characters outside quotes, so nothing is confused by it.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(';');
  return String(value);
}

/**
 * RFC 4180 CSV, UTF-8 with BOM and CRLF endings.
 *
 * The BOM is the mirror image of lib/src/csv.ts, which strips one on the way
 * in: what the сдружение and municipal staff actually use is Excel on a
 * Bulgarian Windows locale, and a Cyrillic export without a BOM opens as
 * mojibake there every single time.
 */
export function serializeCsv(dataset: ExportDataset, rows: Iterable<ExportRow>): string {
  const table: string[][] = [dataset.fields.map((f) => f.name)];
  for (const row of rows) {
    table.push(dataset.fields.map((f) => csvCell(fieldValue(f, row))));
  }
  return BOM + toCsv(table) + '\r\n';
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  license: string;
  license_url: string;
  attribution: string;
  generated_at: string;
  features: {
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] } | null;
    properties: ExportRow;
  }[];
}

/**
 * GeoJSON (RFC 7946), with the licence and attribution as top-level foreign
 * members — permitted by the spec and ignored without complaint by QGIS,
 * MapLibre and Leaflet, so a reuser who never visits /danni still receives the
 * terms along with the data.
 *
 * A dataset with no `geometry` in its catalogue entry cannot reach this
 * function. An aggregate view is not a place: an aggregate FeatureCollection
 * would have to invent a point for a municipality, and somebody would then map
 * it as though every pitch in the municipality stood at its town hall.
 */
export function serializeGeoJSON(
  dataset: ExportDataset,
  rows: Iterable<ExportRow>,
  generatedAt: Date = new Date(),
): FeatureCollection {
  const geometry = dataset.geometry;
  if (!geometry) {
    throw new Error(`opendata: dataset ${dataset.id} declares no geometry`);
  }
  const features: FeatureCollection['features'] = [];
  for (const row of rows) {
    const properties: ExportRow = {};
    let lon: number | null = null;
    let lat: number | null = null;
    for (const field of dataset.fields) {
      const value = fieldValue(field, row);
      if (field.name === geometry.lon) {
        lon = value as number | null;
        continue;
      }
      if (field.name === geometry.lat) {
        lat = value as number | null;
        continue;
      }
      properties[field.name] = value;
    }
    features.push({
      type: 'Feature',
      // `geom` is NOT NULL in the schema, so this is unreachable — but a null
      // geometry is valid GeoJSON, and throwing halfway through a 6 600-row
      // stream would serve a truncated document with a 200.
      geometry: lon === null || lat === null ? null : { type: 'Point', coordinates: [lon, lat] },
      properties,
    });
  }
  return {
    type: 'FeatureCollection',
    license: OPEN_DATA_LICENSE.id,
    license_url: OPEN_DATA_LICENSE.url,
    attribution: OPEN_DATA_LICENSE.attribution,
    generated_at: generatedAt.toISOString(),
    features,
  };
}

export interface JsonExport {
  dataset: string;
  license: string;
  license_url: string;
  attribution: string;
  generated_at: string;
  rows: ExportRow[];
}

/** Tabular JSON for the aggregate datasets, same licence members as GeoJSON. */
export function serializeJson(
  dataset: ExportDataset,
  rows: Iterable<ExportRow>,
  generatedAt: Date = new Date(),
): JsonExport {
  const out: ExportRow[] = [];
  for (const row of rows) {
    const shaped: ExportRow = {};
    for (const field of dataset.fields) shaped[field.name] = fieldValue(field, row);
    out.push(shaped);
  }
  return {
    dataset: dataset.id,
    license: OPEN_DATA_LICENSE.id,
    license_url: OPEN_DATA_LICENSE.url,
    attribution: OPEN_DATA_LICENSE.attribution,
    generated_at: generatedAt.toISOString(),
    rows: out,
  };
}

/**
 * The LICENSE.txt written beside every dump version — the CSV's attribution,
 * since the file itself cannot carry one (see the header).
 */
export function licenseText(version: string): string {
  return [
    'SportKarta — open data',
    '',
    `Version: ${version}`,
    `License: ${OPEN_DATA_LICENSE.name} (${OPEN_DATA_LICENSE.id})`,
    OPEN_DATA_LICENSE.url,
    '',
    'Required attribution on any public use of this data, or of anything',
    'derived from it:',
    '',
    `    ${OPEN_DATA_LICENSE.attribution}`,
    '',
    'The ODbL is share-alike: if you publicly use an adapted version of this',
    'database, you must offer that adapted database under the ODbL as well.',
    'Producing a map, a report or an application FROM the data does not oblige',
    'you to license that work openly — only the database behind it.',
    '',
    'Photographs are not part of this database and are not covered by this',
    'license. They are not included in these exports at all.',
    '',
  ].join('\n');
}

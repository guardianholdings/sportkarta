/**
 * RFC 4180 CSV parsing for operator-supplied files (docs/ROADMAP.md §6 bulk
 * create + results import; Stage 6's municipal inbox is the next caller).
 *
 * db/scripts/load-population.ts splits on commas, which is correct for a
 * two-column file we wrote ourselves and wrong for anything a person exports
 * from a spreadsheet. What actually arrives from the сдружение is Excel on
 * Windows: a UTF-8 BOM, CRLF line endings, quoted fields containing commas, and
 * — because a Bulgarian Windows locale uses the comma as the decimal separator —
 * SEMICOLON delimiters. All four are handled here so no import path has to
 * rediscover them.
 *
 * Pure and dependency-free, so it is property-testable and safe to import from
 * anywhere including a client component.
 */

export interface ParsedCsv {
  /** First row, trimmed. Empty array when the input has no rows at all. */
  headers: string[];
  /** Every row after the header, each padded/truncated to headers.length. */
  rows: string[][];
  delimiter: string;
  /**
   * True when the file ended inside an open quote. Everything after the stray
   * `"` was swallowed into one field, so the row count is NOT the file's row
   * count — callers that write must refuse the file rather than silently
   * importing a truncated version of it.
   */
  truncated: boolean;
}

export const SUPPORTED_DELIMITERS = [',', ';', '\t'] as const;
export type CsvDelimiter = (typeof SUPPORTED_DELIMITERS)[number];

/** Bytes Excel writes at the start of a UTF-8 file. */
const BOM = '﻿';

/**
 * Guess the delimiter from the first line, counting only characters OUTSIDE
 * quotes — a title like `"Футбол, малък"` must not vote for the comma.
 * Ties go to the earlier entry in SUPPORTED_DELIMITERS (comma wins), and a
 * single-column file with no delimiter at all also lands on comma, which parses
 * identically either way.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const firstLine = stripBom(text).split(/\r?\n/, 1)[0] ?? '';
  let best: CsvDelimiter = ',';
  let bestCount = 0;
  for (const candidate of SUPPORTED_DELIMITERS) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i += 1) {
      const char = firstLine[i];
      if (char === '"') {
        // A doubled quote inside a quoted field is an escaped quote, not a close.
        if (inQuotes && firstLine[i + 1] === '"') i += 1;
        else inQuotes = !inQuotes;
      } else if (char === candidate && !inQuotes) {
        count += 1;
      }
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/**
 * Parse CSV into a header row plus data rows.
 *
 * Rows are normalised to the header's width: a short row is padded with empty
 * strings and a long one is truncated. That is deliberate — a ragged file
 * should surface as "this cell is empty" in the validation preview, which the
 * operator can see and fix, rather than as a parse error that rejects the whole
 * upload and says nothing about which row was wrong.
 */
export function parseCsv(text: string, delimiter?: CsvDelimiter): ParsedCsv {
  const source = stripBom(text);
  const sep = delimiter ?? detectDelimiter(source);
  const { records, truncated } = parseRecords(source, sep);

  // Trailing blank lines are an artifact of every text editor and spreadsheet.
  while (records.length > 0 && isBlankRecord(records[records.length - 1] as string[])) {
    records.pop();
  }
  if (records.length === 0) return { headers: [], rows: [], delimiter: sep, truncated };

  const headers = (records[0] as string[]).map((cell) => cell.trim());
  const width = headers.length;
  const rows = records
    .slice(1)
    .filter((record) => !isBlankRecord(record))
    .map((record) => {
      const row = record.slice(0, width);
      while (row.length < width) row.push('');
      return row;
    });

  return { headers, rows, delimiter: sep, truncated };
}

function isBlankRecord(record: string[]): boolean {
  return record.every((cell) => cell.trim() === '');
}

/** The state machine. Handles quoted fields containing sep, CR, LF and "". */
function parseRecords(text: string, sep: string): { records: string[][]; truncated: boolean } {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = (): void => {
    record.push(field);
    field = '';
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
  };

  while (i < text.length) {
    const char = text[i] as string;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"' && field === '') {
      // Only a quote at the START of a field opens a quoted field; a stray one
      // mid-field is literal (`5" nail`), which is what spreadsheets produce.
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === sep) {
      endField();
      i += 1;
      continue;
    }
    if (char === '\r') {
      // CRLF or a lone CR both end the record.
      endRecord();
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (char === '\n') {
      endRecord();
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  // An unterminated quoted field swallows everything after it into one field.
  // The content is still returned so the preview can show what happened — but
  // `truncated` is what callers act on, because the rows they can see are NOT
  // the rows in the file and importing them would silently drop the rest.
  if (field !== '' || record.length > 0 || inQuotes) endRecord();
  return { records, truncated: inQuotes };
}

export interface ToCsvOptions {
  delimiter?: CsvDelimiter;
  /**
   * Prefix cells a spreadsheet would execute as a formula with an apostrophe.
   * ON BY DEFAULT: every export path carries operator- or crowd-supplied text,
   * and defaulting to unsafe is how the one export that forgets becomes the
   * vulnerability. Turn it off only to test the parser itself, where the
   * round-trip has to be byte-exact.
   */
  formulaSafe?: boolean;
}

/** Serialise rows back to CSV — used by the tests and by export paths. */
export function toCsv(rows: readonly (readonly string[])[], options: ToCsvOptions = {}): string {
  const delimiter = options.delimiter ?? ',';
  const formulaSafe = options.formulaSafe ?? true;
  return rows
    .map((row) => row.map((cell) => quoteCell(cell, delimiter, formulaSafe)).join(delimiter))
    .join('\r\n');
}

/**
 * Leading characters a spreadsheet treats as the start of a FORMULA. Prefixed
 * with an apostrophe on export so `=cmd|' /C calc'!A0` in operator- or
 * crowd-supplied text opens as text, not as a command. Stage 6's public CSV
 * dumps go through here too.
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function quoteCell(cell: string, delimiter: string, formulaSafe: boolean): string {
  const safe = formulaSafe && FORMULA_PREFIX.test(cell) ? `'${cell}` : cell;
  return quoteIfNeeded(safe, delimiter);
}

function quoteIfNeeded(cell: string, delimiter: string): string {
  const needsQuotes =
    cell.includes('"') ||
    cell.includes('\n') ||
    cell.includes('\r') ||
    cell.includes(delimiter) ||
    // A leading quote would otherwise be read as opening a quoted field.
    cell.startsWith('"');
  return needsQuotes ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/**
 * Best-effort header → field guess for the column-mapping step, so the common
 * case needs no clicks at all. Matches Bulgarian and English headers, case- and
 * punctuation-insensitively. Returns undefined when nothing is confident.
 */
export function guessColumn(
  header: string,
  aliases: Record<string, readonly string[]>,
): string | undefined {
  const needle = normalizeHeader(header);
  if (needle === '') return undefined;
  for (const [field, names] of Object.entries(aliases)) {
    if (names.some((name) => normalizeHeader(name) === needle)) return field;
  }
  return undefined;
}

function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s_.-]+/g, '');
}

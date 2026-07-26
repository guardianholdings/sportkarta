/**
 * Throwaway validation for docs/enrichment/2026-07/mms-name-fills.csv:
 * proves every generated row survives the REAL parser + normalizer with zero
 * errors before the operator uploads it at /admin/obshtini. Delete after use
 * if unwanted — it skips itself when the file is absent.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCsv, guessColumn } from '../csv.js';
import { MUNICIPAL_FIELDS, normalizeRow, type RawRow } from './normalize.js';
import columns from '../../../apps/web/lib/csv-columns.json' with { type: 'json' };

const CSV_PATH = fileURLToPath(
  new URL('../../../docs/enrichment/2026-07/mms-name-fills.csv', import.meta.url),
);

describe('enrichment 2026-07 mms-name-fills.csv', () => {
  it.skipIf(!existsSync(CSV_PATH))('every row normalizes without errors', () => {
    const parsed = parseCsv(readFileSync(CSV_PATH, 'utf8'));
    expect(parsed.truncated).toBe(false);
    const aliases = (columns as { municipal: Record<string, readonly string[]> }).municipal;
    const mapping = new Map<number, (typeof MUNICIPAL_FIELDS)[number]>();
    for (const [idx, header] of parsed.headers.entries()) {
      const field = guessColumn(header, aliases);
      if (field && (MUNICIPAL_FIELDS as readonly string[]).includes(field) && ![...mapping.values()].includes(field as (typeof MUNICIPAL_FIELDS)[number])) {
        mapping.set(idx, field as (typeof MUNICIPAL_FIELDS)[number]);
      }
    }
    // all 9 fields must be auto-guessed from the header
    expect(new Set(mapping.values()).size).toBe(MUNICIPAL_FIELDS.length);

    expect(parsed.rows.length).toBeGreaterThan(0);
    for (const [i, row] of parsed.rows.entries()) {
      const raw: RawRow = { rowNumber: i + 2 };
      for (const [idx, field] of mapping) raw[field] = row[idx] ?? '';
      const outcome = normalizeRow(raw);
      expect(outcome.ok, `row ${String(i + 2)}: ${JSON.stringify(outcome)}`).toBe(true);
      if (outcome.ok) expect(outcome.row.name).toBeTruthy();
    }
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { detectDelimiter, guessColumn, parseCsv, toCsv } from './csv.js';

/**
 * The CSV parser exists because operator files are Excel files. Every case
 * below is one the сдружение will actually hit: a Bulgarian Windows locale
 * exporting semicolons, a BOM, CRLF, and titles containing commas.
 */

describe('parseCsv', () => {
  it('round-trips arbitrary cell content (property)', () => {
    fc.assert(
      fc.property(
        // Cells deliberately include the characters that break naive splitting.
        fc.array(
          fc.array(fc.stringMatching(/^[a-zА-Я0-9 ,;"\n\r\t-]*$/u, { size: 'small' }), {
            minLength: 1,
            maxLength: 5,
          }),
          { minLength: 2, maxLength: 8 },
        ),
        fc.constantFrom(',' as const, ';' as const, '\t' as const),
        (grid, delimiter) => {
          // Rectangular, since parseCsv normalises to the header width.
          const width = (grid[0] as string[]).length;
          const rectangular = grid.map((row) => {
            const copy = row.slice(0, width);
            while (copy.length < width) copy.push('');
            return copy;
          });
          // A header that is blank in every column would be dropped as a blank
          // record; give the header row stable content.
          const headers = Array.from({ length: width }, (_, i) => `col${String(i)}`);
          const body = rectangular.slice(1);

          // formulaSafe off: this proves the PARSER round-trips, and the
          // export-side apostrophe would (correctly) change the bytes.
          const text = toCsv([headers, ...body], { delimiter, formulaSafe: false });
          const parsed = parseCsv(text, delimiter);

          expect(parsed.headers).toEqual(headers);
          // Blank rows are dropped by design, so compare against the same filter.
          expect(parsed.rows).toEqual(body.filter((row) => row.some((c) => c.trim() !== '')));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('handles the Excel-on-Windows shape: BOM, CRLF, semicolons, quoted commas', () => {
    const text = '﻿обект;спорт;заглавие\r\nsofia-park;football;"Футбол, вечерен"\r\n';
    const parsed = parseCsv(text);
    expect(parsed.delimiter).toBe(';');
    expect(parsed.headers).toEqual(['обект', 'спорт', 'заглавие']);
    expect(parsed.rows).toEqual([['sofia-park', 'football', 'Футбол, вечерен']]);
  });

  it('keeps embedded newlines and escaped quotes inside a quoted field', () => {
    const parsed = parseCsv('a,b\n"line1\nline2","say ""hi"""\n');
    expect(parsed.rows).toEqual([['line1\nline2', 'say "hi"']]);
  });

  it('treats a mid-field quote as literal, the way spreadsheets export it', () => {
    const parsed = parseCsv('size,note\n5" nail,ok\n');
    expect(parsed.rows).toEqual([['5" nail', 'ok']]);
  });

  it('pads short rows and truncates long ones instead of failing the file', () => {
    // A ragged row must reach the validation preview as an empty cell the
    // operator can see, not abort the whole upload with no row number.
    const parsed = parseCsv('a,b,c\n1,2\n1,2,3,4\n');
    expect(parsed.rows).toEqual([
      ['1', '2', ''],
      ['1', '2', '3'],
    ]);
  });

  it('drops trailing and interior blank lines', () => {
    const parsed = parseCsv('a,b\n1,2\n\n3,4\n\n\n');
    expect(parsed.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('returns nothing for an empty or whitespace-only file', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [], delimiter: ',', truncated: false });
    expect(parseCsv('\r\n\r\n').rows).toEqual([]);
  });

  it('does not throw on an unterminated quote', () => {
    // Better a visibly mangled row in the preview than a rejected file.
    const parsed = parseCsv('a,b\n"never closed,2\n');
    expect(parsed.rows).toHaveLength(1);
  });
});

describe('detectDelimiter', () => {
  it('ignores delimiters inside quotes', () => {
    // Three commas, all inside one quoted title, versus two real semicolons.
    expect(detectDelimiter('a;b;"x, y, z"')).toBe(';');
  });

  it('defaults to comma for a single-column file', () => {
    expect(detectDelimiter('заглавие\nФутбол')).toBe(',');
  });

  it('finds tabs', () => {
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
  });
});

describe('guessColumn', () => {
  const aliases = {
    facility: ['обект', 'facility', 'facility slug'],
    sport: ['спорт', 'sport'],
  };

  it('matches either language, ignoring case, spaces and punctuation', () => {
    expect(guessColumn('Обект', aliases)).toBe('facility');
    expect(guessColumn('  FACILITY_SLUG ', aliases)).toBe('facility');
    expect(guessColumn('Спорт', aliases)).toBe('sport');
  });

  it('returns undefined rather than guessing wildly', () => {
    expect(guessColumn('коментар', aliases)).toBeUndefined();
    expect(guessColumn('', aliases)).toBeUndefined();
  });
});

describe('truncation reporting', () => {
  it('flags a file that ends inside an open quote', () => {
    // The rows a caller can see are NOT the rows in the file: everything after
    // the stray quote was swallowed into one field. A writer that imported them
    // would silently drop the rest — the results path DELETEs first, so that
    // would be data destruction.
    const parsed = parseCsv('a,b\n"oops,1\nc,2\nd,3\n');
    expect(parsed.truncated).toBe(true);
    expect(parsed.rows).toHaveLength(1);
  });

  it('does not flag a well-formed file', () => {
    expect(parseCsv('a,b\n"fine, quoted",2\n').truncated).toBe(false);
    expect(parseCsv('').truncated).toBe(false);
  });
});

describe('toCsv formula injection', () => {
  it('neutralises cells a spreadsheet would run as a formula', () => {
    // Stage 6 exports crowd- and operator-supplied text through this.
    for (const payload of ["=cmd|' /C calc'!A0", '+1+1', '-1+1', '@SUM(A1)']) {
      const round = parseCsv(toCsv([['h'], [payload]]));
      expect(round.rows[0]?.[0], payload).toBe(`'${payload}`);
    }
  });

  it('leaves ordinary values alone', () => {
    expect(parseCsv(toCsv([['h'], ['Футбол'], ['3:1']])).rows).toEqual([['Футбол'], ['3:1']]);
  });
});

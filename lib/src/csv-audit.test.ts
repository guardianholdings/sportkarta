import { describe, expect, it } from 'vitest';

import { decodeCsvBytes, parseCsv, stripFormulaGuard, toCsv } from './csv.js';

/**
 * The club audit of 2026-11-14, the CSV half:
 *
 *   * C6 — an upload is BYTES, and Excel on a Bulgarian Windows writes them in
 *     Windows-1251; read as UTF-8 every Cyrillic letter became U+FFFD;
 *   * C11 — the export's formula guard puts an apostrophe before `+359…`, so
 *     POPS's own members.csv could not be imported back.
 */

const HEADER = 'Име;Имейл;Телефон';
const ROW = 'Мария Петрова;maria@example.org;0888 123 456';
const TEXT = `${HEADER}\r\n${ROW}\r\n`;

/** Windows-1251 of Bulgarian text: the Cyrillic block sits at 0xC0–0xFF. */
function cp1251(text: string): Uint8Array {
  return Uint8Array.from(
    [...text].map((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x80) return code;
      if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0;
      throw new Error(`not in the test's Windows-1251 subset: ${char}`);
    }),
  );
}

describe('decodeCsvBytes (C6)', () => {
  it('reads UTF-8, with or without Excel’s byte-order mark', () => {
    const utf8 = new TextEncoder().encode(TEXT);
    expect(decodeCsvBytes(utf8)).toBe(TEXT);
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
    expect(parseCsv(decodeCsvBytes(withBom)).headers).toEqual(['Име', 'Имейл', 'Телефон']);
  });

  it('reads a file Excel saved in Windows-1251 instead of turning Cyrillic into U+FFFD', () => {
    const bytes = cp1251(TEXT);
    // What file.text() did: not one Cyrillic letter survives.
    expect(new TextDecoder().decode(bytes)).toContain('�');
    const decoded = decodeCsvBytes(bytes);
    expect(decoded).toBe(TEXT);
    expect(decoded).not.toContain('�');
    const parsed = parseCsv(decoded);
    expect(parsed.headers).toEqual(['Име', 'Имейл', 'Телефон']);
    expect(parsed.rows[0]?.[0]).toBe('Мария Петрова');
  });

  it('leaves a plain ASCII file and an empty one alone', () => {
    expect(decodeCsvBytes(new TextEncoder().encode('name,email\r\nAnn,a@example.org'))).toBe(
      'name,email\r\nAnn,a@example.org',
    );
    expect(decodeCsvBytes(new Uint8Array())).toBe('');
  });
});

describe('stripFormulaGuard (C11)', () => {
  it('undoes exactly the export guard’s own prefix', () => {
    for (const cell of ['+359 888 123 456', '=1+1', '-5', '@handle', '\tx', '\rx']) {
      const [exported] = parseCsv(toCsv([['h'], [cell]])).rows[0] ?? [];
      expect(exported).toBe(`'${cell}`);
      expect(stripFormulaGuard(String(exported))).toBe(cell);
    }
  });

  it('touches nothing else: an apostrophe that guards nothing stays', () => {
    for (const cell of ["'", "'Нийл", "O'Brien", "''+359", '0888 123 456', '', "'0888"]) {
      expect(stripFormulaGuard(cell)).toBe(cell);
    }
  });

  it('does not weaken the export: a dangerous cell still leaves guarded', () => {
    expect(toCsv([['=cmd'], ['+359 888']])).toBe("'=cmd\r\n'+359 888");
  });
});

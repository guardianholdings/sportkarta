import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readColumnMapping } from '@/lib/admin-csv';

/**
 * The CSV wizards' column mapping (UX audit 2026-10-10, A-1). «— пропусни —»
 * posts '', and Number('') is 0: every skipped field used to be filled from
 * the first column.
 */

const FIELDS = ['facility', 'title', 'description'] as const;

function form(entries: Record<string, string | Blob>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

describe('readColumnMapping', () => {
  it('reads «— пропусни —» as no column, never as column 0', () => {
    const mapping = readColumnMapping(
      form({ 'map.facility': '0', 'map.title': '1', 'map.description': '' }),
      FIELDS,
    );
    expect(mapping).toEqual({ facility: 0, title: 1 });
    expect('description' in mapping).toBe(false);
  });

  it('keeps a genuine first column', () => {
    expect(readColumnMapping(form({ 'map.title': '0' }), FIELDS)).toEqual({ title: 0 });
  });

  it('leaves out a field the form did not post', () => {
    expect(readColumnMapping(form({}), FIELDS)).toEqual({});
  });

  it('refuses anything that is not a plain column index', () => {
    for (const value of ['-1', '1.5', '1e2', ' 2', '2 ', 'abc', '0x1', '99999999999999999999']) {
      expect(readColumnMapping(form({ 'map.title': value }), FIELDS), value).toEqual({});
    }
    expect(readColumnMapping(form({ 'map.title': new Blob(['3']) }), FIELDS)).toEqual({});
  });

  it("reads only the wizard's own fields", () => {
    expect(readColumnMapping(form({ 'map.organizer': '2', 'map.title': '1' }), FIELDS)).toEqual({
      title: 1,
    });
  });
});

describe('the three wizards share it', () => {
  const ADMIN = path.join(process.cwd(), 'app', '[locale]', 'admin', '(protected)');

  for (const wizard of ['sesii', 'rezultati', 'obshtini']) {
    it(`${wizard}/actions.ts reads the mapping through readColumnMapping`, () => {
      const source = readFileSync(path.join(ADMIN, wizard, 'actions.ts'), 'utf8');
      expect(source).toMatch(/readColumnMapping\(/);
      // A local reader is how the '' → 0 bug survived in two of the three.
      expect(source).not.toMatch(/function readMapping\(/);
      expect(source).not.toMatch(/formData\.entries\(\)[\s\S]{0,120}map\./);
    });
  }
});

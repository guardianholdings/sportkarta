import { describe, expect, it } from 'vitest';

import { parseCsv, toCsv } from '../csv.js';

import {
  classifyImportRows,
  normalizeImportRow,
  type ClubImportRow,
  type ExistingMember,
} from './import.js';

/**
 * The club audit of 2026-11-14, the member import's pure half:
 *
 *   * C1 — a child whose guardian e-mail named nobody was created with no
 *     guardian, and then classified `new` again on every re-run of the same
 *     file (a second record, a second abonnement, a second charge);
 *   * C11 — a phone the export guarded (`'+359…`) failed `phone_invalid` when
 *     POPS's own members.csv came back.
 */

const row = (fields: Record<string, string>, line = 2): ClubImportRow => {
  const result = normalizeImportRow(line, fields);
  if (!result.ok) throw new Error(result.errors.join(','));
  return result.row;
};

const child = (id: string, name: string, guardianEmail: string | null): ExistingMember => ({
  id,
  displayName: name,
  email: null,
  phone: null,
  isMinor: true,
  guardianEmail,
});

describe('a child whose guardian the file names by e-mail (C1)', () => {
  const fileRow = row({ name: 'Иван Петров', minor: 'да', guardianEmail: 'nobody@example.org' });

  it('is new the first time', () => {
    expect(classifyImportRows([fileRow], [])).toEqual([{ kind: 'new' }]);
  });

  it('is held for a human on a re-run, when the first run left the child without a guardian', () => {
    // What the first commit wrote: the e-mail named no adult, so no guardian.
    const afterFirstRun = [child('k1', 'Иван  ПЕТРОВ', null)];
    expect(classifyImportRows([fileRow], afterFirstRun)).toEqual([
      { kind: 'conflict', reason: 'name_exists' },
    ]);
  });

  it('is held even when the guardian has joined since — the unlinked child may be the same one', () => {
    const afterFirstRun: ExistingMember[] = [
      child('k1', 'Иван Петров', null),
      {
        id: 'a1',
        displayName: 'Родител',
        email: 'nobody@example.org',
        phone: null,
        isMinor: false,
        guardianEmail: null,
      },
    ];
    expect(classifyImportRows([fileRow], afterFirstRun)).toEqual([
      { kind: 'conflict', reason: 'name_exists' },
    ]);
  });

  it('still matches the child under that guardian, and still lets a namesake of another family in', () => {
    expect(
      classifyImportRows([fileRow], [child('k1', 'Иван Петров', 'nobody@example.org')]),
    ).toEqual([{ kind: 'match', memberId: 'k1' }]);
    // The existing rule (clubs.test.ts): a same-name child under ANOTHER
    // guardian's e-mail is a different child.
    expect(
      classifyImportRows([fileRow], [child('k2', 'Иван Петров', 'other@example.org')]),
    ).toEqual([{ kind: 'new' }]);
    // An adult namesake is nobody's twin.
    expect(
      classifyImportRows([fileRow], [{ ...child('a2', 'Иван Петров', null), isMinor: false }]),
    ).toEqual([{ kind: 'new' }]);
  });
});

describe('POPS’s own export, imported back (C11)', () => {
  it('reads a phone the formula guard prefixed', () => {
    const exported = toCsv([
      ['name', 'email', 'phone'],
      ['Мария Петрова', 'maria@example.org', '+359 888 123 456'],
    ]);
    expect(exported).toContain("'+359 888 123 456");
    const [name, email, phone] = parseCsv(exported).rows[0] ?? [];
    const result = normalizeImportRow(2, { name, email, phone });
    expect(result).toMatchObject({
      ok: true,
      row: { displayName: 'Мария Петрова', email: 'maria@example.org', phone: '+359 888 123 456' },
    });
  });

  it('still refuses what is not a phone, apostrophe or not', () => {
    for (const phone of ["'+359abc", "'0888 123 456", "''+359 888 123 456", "'=1+1"]) {
      const result = normalizeImportRow(2, { name: 'Мария', phone });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors).toContain('phone_invalid');
    }
  });
});

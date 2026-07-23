import { renderSql, type SQL } from '@sportkarta/db';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  guessResultMapping,
  normalizeResultRow,
  previewResults,
  replaceResults,
  resultRowsFromCsv,
  ResultError,
} from '@/lib/results';

/**
 * Results v1 (docs/ROADMAP.md §6, Stage 4.6), at the statement level.
 * The DB-backed companion is db/src/results-schema.test.ts.
 */

function fakeDb(
  members: { id: string; email: string }[] = [],
  occurrence: { started: boolean } | null = { started: true },
) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const runner = {
    execute(query: SQL) {
      const rendered = renderSql(query);
      statements.push(rendered);
      if (/FROM users/i.test(rendered.sql)) return Promise.resolve({ rows: members });
      if (/FROM play_session_occurrences/i.test(rendered.sql)) {
        return Promise.resolve({ rows: occurrence === null ? [] : [occurrence] });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return {
    statements,
    ...runner,
    transaction<T>(callback: (tx: typeof runner) => Promise<T>): Promise<T> {
      return callback(runner);
    },
  };
}

describe('normalizeResultRow', () => {
  it('treats an email as a member and anything else as a label', () => {
    expect(normalizeResultRow({ participant: 'ivan@example.org', position: 1 })).toMatchObject({
      participantEmail: 'ivan@example.org',
      participantLabel: null,
    });
    expect(normalizeResultRow({ participant: 'Отбор А', score: '3:1' })).toMatchObject({
      participantEmail: null,
      participantLabel: 'Отбор А',
    });
  });

  it('accepts a typed time as a score — the no-timing-hardware boundary', () => {
    for (const score of ['3:1', '12:34', '21-19, 19-21, 15-12']) {
      expect(normalizeResultRow({ participant: 'бегач', score }).score).toBe(score);
    }
  });

  it('rejects a row that says nothing happened', () => {
    // Mirrors play_session_results_has_content. A team is who, not what.
    expect(() => normalizeResultRow({ participant: 'гост' })).toThrowError('empty_result');
    expect(() => normalizeResultRow({ participant: 'гост', team: 'А' })).toThrowError(
      'empty_result',
    );
    // A note alone is a result: "DNF" is an outcome.
    expect(normalizeResultRow({ participant: 'гост', note: 'DNF' }).note).toBe('DNF');
  });

  it('rejects a missing participant and a nonsensical position', () => {
    expect(() => normalizeResultRow({ participant: '  ', position: 1 })).toThrowError(
      'participant_required',
    );
    expect(() => normalizeResultRow({ participant: 'a', position: 0 })).toThrowError(
      'invalid_position',
    );
    expect(() => normalizeResultRow({ participant: 'a', position: '1.5' })).toThrowError(
      'invalid_position',
    );
  });

  it('enforces the same length caps as the CHECK constraints', () => {
    expect(() => normalizeResultRow({ participant: 'x'.repeat(81), position: 1 })).toThrowError(
      'participant_too_long',
    );
    expect(() =>
      normalizeResultRow({ participant: 'a', position: 1, score: 'x'.repeat(41) }),
    ).toThrowError('score_too_long');
    expect(() =>
      normalizeResultRow({ participant: 'a', position: 1, note: 'x'.repeat(301) }),
    ).toThrowError('note_too_long');
  });

  it('normalises blanks to NULL rather than empty strings', () => {
    const row = normalizeResultRow({ participant: 'a', position: 1, team: '   ', note: '' });
    expect(row.team).toBeNull();
    expect(row.note).toBeNull();
  });
});

describe('guessResultMapping', () => {
  it('maps Bulgarian and English headers', () => {
    expect(guessResultMapping(['участник', 'отбор', 'място', 'резултат'])).toMatchObject({
      participant: 0,
      team: 1,
      position: 2,
      score: 3,
    });
    expect(guessResultMapping(['name', 'team', 'position', 'time'])).toMatchObject({
      participant: 0,
      score: 3,
    });
  });
});

describe('previewResults', () => {
  it('resolves members in one query and reports unknown addresses', async () => {
    const db = fakeDb([{ id: 'user_1', email: 'ivan@example.org' }]);
    const preview = await previewResults(db, [
      { rowNumber: 2, participant: 'ivan@example.org', position: '1' },
      { rowNumber: 3, participant: 'ghost@example.org', position: '2' },
      { rowNumber: 4, participant: 'гост', position: '3' },
    ]);

    expect(db.statements.filter((s) => /FROM users/i.test(s.sql))).toHaveLength(1);
    expect(preview.rows.map((r) => r.error)).toEqual([undefined, 'unknown_member', undefined]);
    expect(preview.rows[0]?.userId).toBe('user_1');
    expect(preview.validCount).toBe(2);
  });

  it('catches a member listed twice before the unique index does', async () => {
    // The operator gets a row number instead of a constraint name.
    const db = fakeDb([{ id: 'user_1', email: 'ivan@example.org' }]);
    const preview = await previewResults(db, [
      { rowNumber: 2, participant: 'ivan@example.org', position: '1' },
      { rowNumber: 3, participant: 'IVAN@example.org', position: '2' },
    ]);
    expect(preview.rows[1]?.error).toBe('duplicate_member');
  });

  it('allows two guests with the same label', async () => {
    // Two people can genuinely both be entered as "гост".
    const db = fakeDb();
    const preview = await previewResults(db, [
      { rowNumber: 2, participant: 'гост', position: '1' },
      { rowNumber: 3, participant: 'гост', position: '2' },
    ]);
    expect(preview.validCount).toBe(2);
  });
});

describe('replaceResults', () => {
  it('replaces the set and writes only the valid rows', async () => {
    const db = fakeDb([{ id: 'user_1', email: 'ivan@example.org' }]);
    const outcome = await replaceResults(db, 'occ_1', 'admin_1', [
      { rowNumber: 2, participant: 'ivan@example.org', position: '1', score: '12:30' },
      { rowNumber: 3, participant: 'ghost@example.org', position: '2' },
      { rowNumber: 4, participant: 'гост', position: '3' },
    ]);

    expect(outcome.saved).toBe(2);
    expect(outcome.skipped.map((r) => r.rowNumber)).toEqual([3]);
    const text = db.statements.map((s) => s.sql).join('\n');
    // Replace, not merge: the form expresses "here is the result".
    expect(text).toMatch(/DELETE FROM play_session_results/i);
    expect(
      db.statements.filter((s) => /INSERT INTO play_session_results/i.test(s.sql)),
    ).toHaveLength(2);
    // The recorder is attributed on every row.
    const insert = db.statements.find((s) => /INSERT INTO play_session_results/i.test(s.sql));
    expect(insert?.params).toContain('admin_1');
  });

  it('refuses to record a result for a session that has not happened', async () => {
    const db = fakeDb([], { started: false });
    await expect(
      replaceResults(db, 'occ_1', 'admin_1', [
        { rowNumber: 2, participant: 'гост', position: '1' },
      ]),
    ).rejects.toThrowError('occurrence_not_started');
  });

  it('reports a missing occurrence rather than writing nothing silently', async () => {
    const db = fakeDb([], null);
    await expect(
      replaceResults(db, 'nope', 'admin_1', [{ rowNumber: 2, participant: 'гост', position: '1' }]),
    ).rejects.toThrowError('occurrence_not_found');
  });
});

describe('resultRowsFromCsv', () => {
  it('reads a semicolon file with a BOM, the way Excel writes it', () => {
    const text = '﻿участник;място;резултат\r\nИван;1;12:34\r\n';
    const rows = resultRowsFromCsv(text, guessResultMapping(['участник', 'място', 'резултат']));
    expect(rows).toEqual([
      { rowNumber: 2, participant: 'Иван', team: '', position: '1', score: '12:34', note: '' },
    ]);
  });
});

describe('ResultError', () => {
  it('carries a code and no user input', () => {
    const error = new ResultError('empty_result');
    expect(error.code).toBe('empty_result');
    expect(error.message).toBe('empty_result');
  });
});

describe('admin-only enforcement', () => {
  it('calls requireRole(admin) in every results action', () => {
    const source = readFileSync(
      new URL('../app/[locale]/admin/(protected)/rezultati/actions.ts', import.meta.url),
      'utf8',
    );
    const bodies = source.split(/export async function /).slice(1);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body, body.slice(0, body.indexOf('('))).toMatch(/await requireRole\('admin'\)/);
    }
    expect(source).not.toMatch(/import[^;]*requireAdmin/);
  });
});

describe('re-saving must not defeat erasure', () => {
  it('never deletes anonymised rows', async () => {
    // A row with neither a member nor a label is an ERASED participant. It
    // cannot be re-expressed in the form, so a wholesale replace would destroy
    // the other side's record of that game — and the count the GDPR tombstone
    // reports.
    const db = fakeDb([{ id: 'user_1', email: 'ivan@example.org' }]);
    await replaceResults(db, 'occ_1', 'admin_1', [
      { rowNumber: 2, participant: 'гост', position: '1' },
    ]);
    const del = db.statements.find((s) => /DELETE FROM play_session_results/i.test(s.sql));
    expect(del?.sql).toMatch(/NOT \(participant_user_id IS NULL AND participant_label IS NULL\)/i);
  });

  it('takes the occurrence row FOR UPDATE so two saves cannot union', async () => {
    const db = fakeDb([]);
    await replaceResults(db, 'occ_1', 'admin_1', [
      { rowNumber: 2, participant: 'гост', position: '1' },
    ]);
    const lock = db.statements.find((s) => /FROM play_session_occurrences/i.test(s.sql));
    expect(lock?.sql).toMatch(/FOR UPDATE/i);
  });

  it('refuses a truncated CSV rather than replacing results with a fragment', () => {
    // replaceResults DELETEs first, so importing a silently-truncated file
    // would be data destruction.
    expect(() =>
      resultRowsFromCsv('участник,място\n"oops,1\nИван,2\n', { participant: 0, position: 1 }),
    ).toThrowError('csv_truncated');
  });
});

describe('the editor round-trip', () => {
  it('classifies a member only by email, so a display name would become a label', () => {
    // This is why the editor pre-fills the ADDRESS: pre-filling "Иван Петров"
    // would re-save the row as free text carrying that person's real name, in a
    // column no foreign key can ever clear.
    expect(normalizeResultRow({ participant: 'Иван Петров', position: 1 })).toMatchObject({
      participantEmail: null,
      participantLabel: 'Иван Петров',
    });
    expect(normalizeResultRow({ participant: 'ivan@example.org', position: 1 })).toMatchObject({
      participantEmail: 'ivan@example.org',
      participantLabel: null,
    });
  });

  it('pre-fills the editor from the email, never the display name', () => {
    const source = readFileSync(
      new URL(
        '../app/[locale]/admin/(protected)/rezultati/[occurrenceId]/page.tsx',
        import.meta.url,
      ),
      'utf8',
    );
    expect(source).toMatch(/participant: row\.email \?\? row\.participantLabel/);
    expect(source).not.toMatch(/participant: row\.displayName/);
  });
});

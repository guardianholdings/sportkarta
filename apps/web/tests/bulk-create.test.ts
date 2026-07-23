import { renderSql, type SQL } from '@sportkarta/db';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  bulkCreateSessions,
  guessMapping,
  previewBulkRows,
  rowsFromCsv,
  rowsFromGrid,
  sampleCsv,
} from '@/lib/sessions/bulk-create';

/**
 * Bulk-create (docs/ROADMAP.md §6, Stage 4.5), at the statement level.
 *
 * The behaviour that matters commercially is COMMIT-VALID-SKIP-INVALID: a file
 * with three bad rows out of two hundred must create 197 sessions and name the
 * three, not reject the upload.
 */

const FACILITY_A = '00000000-0000-4000-8000-00000000000a';
const FACILITY_B = '00000000-0000-4000-8000-00000000000b';

function fakeDb(facilities: { id: string; slug: string | null }[]) {
  const statements: { sql: string; params: unknown[] }[] = [];
  let inserts = 0;
  const runner = {
    execute(query: SQL) {
      const rendered = renderSql(query);
      statements.push(rendered);
      if (/FROM facilities/i.test(rendered.sql)) return Promise.resolve({ rows: facilities });
      if (/INSERT INTO play_sessions/i.test(rendered.sql)) {
        inserts += 1;
        return Promise.resolve({ rows: [{ id: `session_${String(inserts)}` }] });
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

const HEADER = 'обект,спорт,заглавие,дата,час,продължителност,повторение,капацитет,ниво,видимост';
const GOOD = `sofia-a,football,"Вечерен футбол",2099-09-01,18:00,90,FREQ=WEEKLY;BYDAY=TU,12,any,public`;

describe('guessMapping', () => {
  it('maps a Bulgarian header row with no clicks', () => {
    const mapping = guessMapping(HEADER.split(','));
    expect(mapping).toMatchObject({
      facility: 0,
      sport: 1,
      title: 2,
      date: 3,
      time: 4,
      duration: 5,
      rrule: 6,
      capacity: 7,
      skillLevel: 8,
      visibility: 9,
    });
  });

  it('maps an English header row too', () => {
    const mapping = guessMapping(['facility', 'sport', 'title', 'date', 'time', 'duration']);
    expect(mapping).toMatchObject({ facility: 0, sport: 1, title: 2 });
  });

  it('leaves an unrecognised column unmapped rather than guessing', () => {
    expect(guessMapping(['коментар'])).toEqual({});
  });
});

describe('rowsFromCsv', () => {
  it('numbers rows the way the operator counts them', () => {
    const rows = rowsFromCsv(`${HEADER}\n${GOOD}\n`, guessMapping(HEADER.split(',')));
    // Header is row 1, so the first data row is row 2.
    expect(rows[0]?.rowNumber).toBe(2);
    expect(rows[0]?.facility).toBe('sofia-a');
    expect(rows[0]?.title).toBe('Вечерен футбол');
  });

  it('parses the sample file it offers for download', () => {
    const text = sampleCsv();
    const headers = text.split('\r\n')[0]?.split(',') ?? [];
    const rows = rowsFromCsv(text, guessMapping(headers));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sport).toBe('football');
  });
});

describe('rowsFromGrid', () => {
  it('turns one slot into one row per facility, with a weekly rule', () => {
    const rows = rowsFromGrid({
      facilityIds: [FACILITY_A, FACILITY_B],
      sport: 'football',
      title: 'Общински футбол',
      date: '2099-09-01',
      time: '18:00',
      durationMinutes: 90,
      weekdays: [4, 2],
      capacity: 12,
    });
    expect(rows).toHaveLength(2);
    // Weekdays are canonicalised into RFC order, not the click order.
    expect(rows[0]?.rrule).toBe('FREQ=WEEKLY;BYDAY=TU,TH');
    expect(rows.map((r) => r.facility)).toEqual([FACILITY_A, FACILITY_B]);
  });

  it('produces a one-off when no weekday is ticked', () => {
    const rows = rowsFromGrid({
      facilityIds: [FACILITY_A],
      sport: 'football',
      title: 'Турнир',
      date: '2099-09-01',
      time: '10:00',
      durationMinutes: 120,
      weekdays: [],
    });
    expect(rows[0]?.rrule).toBe('');
  });
});

describe('previewBulkRows', () => {
  it('resolves facilities by slug or id in ONE query', async () => {
    const db = fakeDb([{ id: FACILITY_A, slug: 'sofia-a' }]);
    await previewBulkRows(db, [
      {
        rowNumber: 2,
        facility: 'sofia-a',
        sport: 'football',
        title: 'A',
        date: '2099-09-01',
        time: '18:00',
        duration: '90',
      },
      {
        rowNumber: 3,
        facility: FACILITY_A,
        sport: 'football',
        title: 'B',
        date: '2099-09-01',
        time: '19:00',
        duration: '90',
      },
    ]);
    // A 200-row file must not be 200 round trips.
    const lookups = db.statements.filter((s) => /FROM facilities/i.test(s.sql));
    expect(lookups).toHaveLength(1);
  });

  it('marks each row ok or skipped with a translatable reason', async () => {
    const db = fakeDb([{ id: FACILITY_A, slug: 'sofia-a' }]);
    const preview = await previewBulkRows(db, [
      {
        rowNumber: 2,
        facility: 'sofia-a',
        sport: 'football',
        title: 'Добър',
        date: '2099-09-01',
        time: '18:00',
        duration: '90',
      },
      {
        rowNumber: 3,
        facility: 'nope',
        sport: 'football',
        title: 'Липсващ обект',
        date: '2099-09-01',
        time: '18:00',
        duration: '90',
      },
      {
        rowNumber: 4,
        facility: 'sofia-a',
        sport: 'kabaddi',
        title: 'Лош спорт',
        date: '2099-09-01',
        time: '18:00',
        duration: '90',
      },
      {
        rowNumber: 5,
        facility: 'sofia-a',
        sport: 'football',
        title: 'Лошо правило',
        date: '2099-09-01',
        time: '18:00',
        duration: '90',
        rrule: 'FREQ=MONTHLY',
      },
      {
        rowNumber: 6,
        facility: 'sofia-a',
        sport: 'football',
        title: '',
        date: '2099-09-01',
        time: '18:00',
        duration: '90',
      },
    ]);

    expect(preview.validCount).toBe(1);
    expect(preview.rows.map((r) => r.error)).toEqual([
      undefined,
      'facility_not_found',
      'invalid_sport',
      // The engine's own slug survives, so the operator is told MONTHLY is not
      // supported rather than "something went wrong".
      'rrule_unsupported_freq',
      'title_required',
    ]);
    // Row numbers are preserved so the reason can be found in the file.
    expect(preview.rows.map((r) => r.rowNumber)).toEqual([2, 3, 4, 5, 6]);
  });

  it('never puts operator text into an error code', async () => {
    const db = fakeDb([{ id: FACILITY_A, slug: 'sofia-a' }]);
    const preview = await previewBulkRows(db, [
      {
        rowNumber: 2,
        facility: 'sofia-a',
        sport: 'football',
        title: 'x'.repeat(200),
        date: '2099-09-01',
        time: '18:00',
        duration: '90',
      },
    ]);
    expect(preview.rows[0]?.error).toBe('title_too_long');
    expect(JSON.stringify(preview.rows[0]?.error)).not.toContain('xxx');
  });
});

describe('bulkCreateSessions', () => {
  it('creates the valid rows and reports the skipped ones', async () => {
    const db = fakeDb([
      { id: FACILITY_A, slug: 'sofia-a' },
      { id: FACILITY_B, slug: 'sofia-b' },
    ]);
    const result = await bulkCreateSessions(db, 'admin_1', [
      {
        rowNumber: 2,
        facility: 'sofia-a',
        sport: 'football',
        title: 'A',
        date: '2099-09-01',
        time: '18:00',
        duration: '90',
      },
      {
        rowNumber: 3,
        facility: 'missing',
        sport: 'football',
        title: 'B',
        date: '2099-09-01',
        time: '18:00',
        duration: '90',
      },
      {
        rowNumber: 4,
        facility: 'sofia-b',
        sport: 'football',
        title: 'C',
        date: '2099-09-01',
        time: '18:00',
        duration: '90',
      },
    ]);

    // The whole point: one bad row does not cost the operator the other two.
    expect(result.created).toBe(2);
    expect(result.skipped.map((r) => ({ row: r.rowNumber, error: r.error }))).toEqual([
      { row: 3, error: 'facility_not_found' },
    ]);
  });

  it('writes the organiser and never an occurrence', async () => {
    const db = fakeDb([{ id: FACILITY_A, slug: 'sofia-a' }]);
    await bulkCreateSessions(db, 'admin_1', [
      {
        rowNumber: 2,
        facility: 'sofia-a',
        sport: 'football',
        title: 'A',
        date: '2099-09-01',
        time: '18:00',
        duration: '90',
      },
    ]);
    const text = db.statements.map((s) => s.sql).join('\n');
    expect(text).toMatch(/INSERT INTO play_sessions/i);
    // Occurrences come only from the materializer — one implementation of the
    // recurrence rules in the system.
    expect(text).not.toMatch(/INSERT INTO play_session_occurrences/i);
    const insert = db.statements.find((s) => /INSERT INTO play_sessions/i.test(s.sql));
    expect(insert?.params).toContain('admin_1');
  });
});

describe('admin-only enforcement', () => {
  it('calls requireRole(admin), not requireAdmin, in every action', () => {
    // requireAdmin() has meant "ambassador or admin" since Stage 3.3, and these
    // are the сдружение's official national slots — an ambassador's authority
    // is municipality-scoped moderation, not this.
    const source = readFileSync(
      new URL('../app/[locale]/admin/(protected)/sesii/actions.ts', import.meta.url),
      'utf8',
    );
    // Split on the exports and check each body, so a mention in a comment
    // cannot make this pass and an unguarded action cannot hide behind one.
    const bodies = source.split(/export async function /).slice(1);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body, body.slice(0, body.indexOf('('))).toMatch(/await requireRole\('admin'\)/);
    }
    // …and the weaker gate is not even imported, so it cannot be reached for.
    // (The doc comment names it deliberately, which is why this checks the
    // import rather than any mention.)
    expect(source).not.toMatch(/import[^;]*requireAdmin/);
  });
});

describe('label bags handed to client components', () => {
  // A message containing {count} throws FORMATTING_ERROR when read with t() and
  // no value — and the client component is the one that fills the count in.
  // This caught a real 4-error page in the browser; the guard keeps it caught.
  const pages = [
    '../app/[locale]/admin/(protected)/sesii/page.tsx',
    '../app/[locale]/admin/(protected)/rezultati/[occurrenceId]/page.tsx',
  ];

  it('reads placeholder-bearing messages with t.raw, never t()', () => {
    for (const page of pages) {
      const source = readFileSync(new URL(page, import.meta.url), 'utf8');
      // The label maps must use t.raw; a bare `t(key)` in a map would format.
      expect(source, page).not.toMatch(/\[key, t\(key\)\]/);
      expect(source, page).toMatch(/t\.raw\(key\)/);
    }
  });
});

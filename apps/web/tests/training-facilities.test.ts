import { renderSql, type SQL } from '@sportkarta/db';
import { describe, expect, it } from 'vitest';

import { MEMBER_FACILITIES_LIMIT, memberFacilities } from '@/lib/training-facilities';

/**
 * The training form's place picker (UX audit 2026-10-10, S-5): the member's
 * OWN places, not the most recently edited facilities in the country.
 */
function fakeDb(rows: Record<string, unknown>[] = []) {
  const statements: { sql: string; params: unknown[] }[] = [];
  return {
    statements,
    execute(query: SQL) {
      statements.push(renderSql(query));
      return Promise.resolve({ rows });
    },
  };
}

describe('memberFacilities', () => {
  it('reads trainings, contributions and check-ins — each keyed by the member', async () => {
    const db = fakeDb();
    await memberFacilities(db, 'member_1');
    const { sql, params } = db.statements[0] ?? { sql: '', params: [] };
    for (const source of ['training_logs', 'points_ledger', 'play_session_checkins']) {
      expect(sql, source).toContain(source);
    }
    // Three branches, three member predicates, all bound to the caller's id: a
    // branch without one would list other people's places.
    expect(sql.match(/\.user_id = \$\d+/g)).toHaveLength(3);
    expect(params.filter((param) => param === 'member_1')).toHaveLength(3);
  });

  it('is no longer "recently updated anywhere"', async () => {
    const db = fakeDb();
    await memberFacilities(db, 'member_1');
    const sql = db.statements[0]?.sql ?? '';
    expect(sql).not.toMatch(/updated_at/);
    expect(sql).toMatch(/ORDER BY l\.at DESC/);
    expect(db.statements[0]?.params).toContain(MEMBER_FACILITIES_LIMIT);
  });

  it('skips places that are gone or have no name', async () => {
    const db = fakeDb();
    await memberFacilities(db, 'member_1');
    const sql = db.statements[0]?.sql ?? '';
    expect(sql).toContain("f.status <> 'gone'");
    expect(sql).toContain("btrim(f.name) <> ''");
  });

  it('maps rows to id and name', async () => {
    const db = fakeDb([{ id: 'f1', name: 'Борисова градина' }]);
    expect(await memberFacilities(db, 'member_1')).toEqual([
      { id: 'f1', name: 'Борисова градина' },
    ]);
  });
});

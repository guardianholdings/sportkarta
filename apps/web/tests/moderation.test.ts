import { readFileSync } from 'node:fs';
import path from 'node:path';

import { renderSql, type SQL } from '@sportkarta/db';
import { describe, expect, it } from 'vitest';

import { grantAmbassador, revokeAmbassador } from '@/lib/ambassadors';
import { decideFacility, decidePhoto, resolveReport, scopeClause } from '@/lib/moderation';

/**
 * Scope and decision logging at the statement level. The DB-backed companion
 * (db/src/moderation-authz.test.ts) proves the same predicate refuses
 * out-of-scope work against real Postgres; these assert that every mutation
 * actually carries it, and that nothing is decided without being logged.
 */

const AMBASSADOR = { id: 'user_amb', role: 'ambassador' as const };
const ADMIN = { id: 'user_admin', role: 'admin' as const };
const MEMBER = { id: 'user_plain', role: 'user' as const };
const PHOTO = '00000000-0000-4000-8000-0000000000p1'.replace('p1', 'a1');
const FACILITY = '00000000-0000-4000-8000-000000000001';

function fakeDb(responses: Record<string, unknown>[][] = []) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const queue = [...responses];
  const runner = {
    execute(query: SQL) {
      statements.push(renderSql(query));
      return Promise.resolve({ rows: queue.shift() ?? [] });
    },
  };
  return {
    statements,
    ...runner,
    transaction<T>(callback: (tx: typeof runner) => Promise<T>): Promise<T> {
      return callback(runner);
    },
    text(): string {
      return statements.map((s) => `${s.sql} ${JSON.stringify(s.params)}`).join('\n');
    },
  };
}

describe('scopeClause', () => {
  it('limits an ambassador to their own municipalities', () => {
    const rendered = renderSql(scopeClause(AMBASSADOR));
    expect(rendered.sql).toMatch(/municipality_id IN/i);
    expect(rendered.sql).toMatch(/ambassador_municipalities/);
    expect(rendered.params).toEqual(['user_amb']);
  });

  it('does not constrain an admin', () => {
    expect(renderSql(scopeClause(ADMIN)).sql.trim()).toBe('TRUE');
  });

  it('gives a plain member nothing, even by mistake', () => {
    // Defence in depth: reaching here with role='user' should be impossible,
    // and if it happens the predicate must be false rather than unconstrained.
    expect(renderSql(scopeClause(MEMBER)).sql.trim()).toBe('FALSE');
  });
});

describe('decidePhoto', () => {
  it('carries the scope in the statement and logs the decision', async () => {
    const db = fakeDb([
      [
        {
          id: PHOTO,
          facility_id: FACILITY,
          created_at: '2026-07-20T10:00:00Z',
          municipality_id: 7,
        },
      ],
      [],
    ]);
    const result = await decidePhoto(db, AMBASSADOR, PHOTO, 'approved');

    expect(result.applied).toBe(true);
    const [update, log] = db.statements;
    expect(update?.sql).toMatch(/UPDATE facility_photos/i);
    expect(update?.sql).toMatch(/ambassador_municipalities/);
    expect(update?.sql).toMatch(/status = 'pending'/);
    expect(log?.sql).toMatch(/INSERT INTO moderation_decisions/i);
    // queued_at comes from the item, so time-to-decision is measurable.
    expect(log?.params).toContain('2026-07-20T10:00:00Z');
    expect(log?.params).toContain(AMBASSADOR.id);
  });

  it('logs nothing when the update matched no row', async () => {
    // Out of scope, already decided, or absent — indistinguishable by design.
    const db = fakeDb([[]]);
    const result = await decidePhoto(db, AMBASSADOR, PHOTO, 'approved');

    expect(result.applied).toBe(false);
    expect(db.statements).toHaveLength(1);
    expect(db.text()).not.toMatch(/moderation_decisions/);
  });
});

describe('resolveReport', () => {
  it('is scoped and logged', async () => {
    const db = fakeDb([
      [
        {
          id: PHOTO,
          facility_id: FACILITY,
          created_at: '2026-07-20T10:00:00Z',
          municipality_id: 3,
        },
      ],
      [],
    ]);
    await resolveReport(db, AMBASSADOR, PHOTO, 'dismissed');
    expect(db.statements[0]?.sql).toMatch(/UPDATE facility_reports/i);
    expect(db.statements[0]?.sql).toMatch(/ambassador_municipalities/);
    expect(db.statements[1]?.sql).toMatch(/INSERT INTO moderation_decisions/i);
  });
});

describe('decideFacility', () => {
  it('flips the status, writes the field audit row, and logs the decision', async () => {
    const db = fakeDb([
      [{ id: FACILITY, created_at: '2026-07-19T08:00:00Z', municipality_id: 5 }],
      [],
      [],
    ]);
    const result = await decideFacility(db, AMBASSADOR, FACILITY, 'verified');

    expect(result.applied).toBe(true);
    const text = db.text();
    expect(text).toMatch(/UPDATE facilities/i);
    expect(text).toMatch(/ambassador_municipalities/);
    // Both trails agree: the field-level audit and the moderation log.
    expect(text).toMatch(/INSERT INTO facility_edits/i);
    expect(text).toMatch(/INSERT INTO moderation_decisions/i);
  });

  it('touches nothing when the facility is out of scope', async () => {
    const db = fakeDb([[]]);
    const result = await decideFacility(db, AMBASSADOR, FACILITY, 'gone');

    expect(result.applied).toBe(false);
    expect(db.text()).not.toMatch(/facility_edits|moderation_decisions/);
  });
});

describe('the facility editor is scoped too', () => {
  // This screen can set `status` and rewrite every field, and it does NOT go
  // through the logged moderation path — so an unscoped version would let any
  // ambassador mark a facility on the other side of the country `gone`,
  // frozen against future imports, with nothing in the decision log. The scope
  // must be in the statements, not only in a check before them.
  it('carries the scope in both the row lock and the update', async () => {
    const source = readFileSync(
      path.join(process.cwd(), 'app/[locale]/admin/(protected)/facilities/actions.ts'),
      'utf8',
    );

    expect(source).toMatch(/scopeClause\(/);
    // The SELECT ... FOR UPDATE that decides whether the edit proceeds.
    expect(source).toMatch(/FROM facilities f WHERE f\.id = \$\{facilityId\} AND \$\{scope\}/);
    // And the UPDATE itself, so a bypassed read still writes nothing.
    expect(source).toMatch(/UPDATE facilities f SET[\s\S]*?AND \$\{scope\}/);
  });

  it('reads the list and the detail through the scoped queries', () => {
    const adminData = readFileSync(path.join(process.cwd(), 'lib/admin-data.ts'), 'utf8');
    // Both take an actor and apply scopeClause; an unscoped variant next to
    // them would invite the next screen to call the wrong one.
    expect(adminData).toMatch(/export async function listFacilities\(\s*actor: ModerationActor/);
    expect(adminData).toMatch(/export async function getFacility\(\s*actor: ModerationActor/);
    expect(adminData).not.toMatch(/export async function pendingPhotos\(/);
    expect(adminData).not.toMatch(/export async function pendingReports\(/);
  });
});

describe('granting and revoking', () => {
  it('promotes only a plain member', async () => {
    const db = fakeDb([[{ id: 'user_1' }]]);
    expect(await grantAmbassador(db, 'user_1')).toEqual({ ok: true });
    expect(db.statements[0]?.sql).toMatch(/role = 'user'/);
  });

  it('refuses to demote an admin through the grant screen', async () => {
    const db = fakeDb([[], [{ role: 'admin' }]]);
    expect(await grantAmbassador(db, 'user_admin')).toEqual({ ok: false, reason: 'is_admin' });
  });

  it('reports a missing account rather than silently doing nothing', async () => {
    const db = fakeDb([[], []]);
    expect(await grantAmbassador(db, 'ghost')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('revokes the scope together with the role', async () => {
    const db = fakeDb([[], []]);
    await revokeAmbassador(db, 'user_1');
    const text = db.text();
    // A leftover scope row would silently reactivate on a future re-grant.
    expect(text).toMatch(/DELETE FROM ambassador_municipalities/i);
    expect(text).toMatch(/SET role = 'user'/);
  });
});

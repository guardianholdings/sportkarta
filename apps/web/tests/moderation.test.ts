import { readFileSync } from 'node:fs';
import path from 'node:path';

import { renderSql, type SQL } from '@sportkarta/db';
import { describe, expect, it, vi } from 'vitest';

import { grantAmbassador, revokeAmbassador } from '@/lib/ambassadors';
import {
  decideFacility,
  decidePhoto,
  isRefusal,
  resolveReport,
  scopeClause,
  unpublishPhoto,
} from '@/lib/moderation';

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

const STORED = 'facilities/2026/09/00000000-0000-4000-8000-0000000000f1.webp';
/** A refusal needs a reason from the vocabulary (0033); any valid one will do here. */
const REASON = 'identifiable_person';

/**
 * `events` is one ordered timeline shared with fakeFiles, so a test can assert
 * that a file was deleted only AFTER the transaction that decided it committed.
 * `failCommit` makes the transaction throw once its callback has run — the
 * decision was made in SQL but never became true.
 */
function fakeDb(
  responses: Record<string, unknown>[][] = [],
  events: string[] = [],
  failCommit = false,
) {
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
    events,
    ...runner,
    async transaction<T>(callback: (tx: typeof runner) => Promise<T>): Promise<T> {
      const result = await callback(runner);
      if (failCommit) throw new Error('commit failed');
      events.push('commit');
      return result;
    },
    text(): string {
      return statements.map((s) => `${s.sql} ${JSON.stringify(s.params)}`).join('\n');
    },
  };
}

function fakeFiles(events: string[], fail = false) {
  return {
    delete(key: string): Promise<void> {
      events.push(`delete ${key}`);
      // Shaped like a real fs error: the MESSAGE embeds the path.
      const error = Object.assign(
        new Error(`EACCES: permission denied, rm '/data/uploads/${key}'`),
        {
          code: 'EACCES',
        },
      );
      return fail ? Promise.reject(error) : Promise.resolve();
    },
  };
}

const PHOTO_ROW = {
  id: 'photo-row',
  facility_id: FACILITY,
  storage_path: STORED,
  created_at: '2026-07-20T10:00:00Z',
  municipality_id: 7,
};

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
    const result = await decidePhoto(db, AMBASSADOR, PHOTO, 'approved', fakeFiles(db.events));

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
    const result = await decidePhoto(db, AMBASSADOR, PHOTO, 'approved', fakeFiles(db.events));

    expect(result.applied).toBe(false);
    expect(db.statements).toHaveLength(1);
    expect(db.text()).not.toMatch(/moderation_decisions/);
  });

  it('deletes a rejected photo’s file, and only after the decision committed', async () => {
    // The usual reason to reject is that the photo shows people; keeping the
    // file (and every backup of it) would keep exactly what was refused.
    const db = fakeDb([[PHOTO_ROW], []]);
    const result = await decidePhoto(db, AMBASSADOR, PHOTO, 'rejected', fakeFiles(db.events), REASON);

    expect(result.applied).toBe(true);
    expect(db.events).toEqual(['commit', `delete ${STORED}`]);
    // The key comes from the row the UPDATE matched, never from the caller.
    expect(db.statements[0]?.sql).toMatch(/RETURNING[\s\S]*storage_path/);
  });

  it('keeps an approved photo’s file', async () => {
    const db = fakeDb([[PHOTO_ROW], []]);
    await decidePhoto(db, AMBASSADOR, PHOTO, 'approved', fakeFiles(db.events));
    expect(db.events).toEqual(['commit']);
  });

  it('deletes nothing when the rejection matched no row', async () => {
    // An out-of-scope ambassador must not be able to destroy a file either.
    const db = fakeDb([[]]);
    await decidePhoto(db, AMBASSADOR, PHOTO, 'rejected', fakeFiles(db.events), REASON);
    expect(db.events.filter((e) => e.startsWith('delete'))).toEqual([]);
  });

  it('deletes nothing when the transaction fails to commit', async () => {
    // Deleting first would leave a still-pending (or later approved) row
    // pointing at nothing — the one ordering that loses data.
    const db = fakeDb([[PHOTO_ROW], []], [], true);
    await expect(
      decidePhoto(db, AMBASSADOR, PHOTO, 'rejected', fakeFiles(db.events), REASON),
    ).rejects.toThrow('commit failed');
    expect(db.events).toEqual([]);
  });

  it('stands by a committed rejection even when the file delete fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = fakeDb([[PHOTO_ROW], []]);
    const result = await decidePhoto(db, AMBASSADOR, PHOTO, 'rejected', fakeFiles(db.events, true), REASON);
    expect(result.applied).toBe(true);
    expect(db.events).toEqual(['commit', `delete ${STORED}`]);
    // The failure is reported by photo id and error code; the log carries no
    // path, and not the error message that would echo one.
    expect(logged).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(logged.mock.calls);
    expect(line).toContain(PHOTO);
    expect(line).toContain('EACCES');
    expect(line).not.toContain(STORED);
    logged.mockRestore();
  });
});

describe('unpublishPhoto', () => {
  it('takes down only an APPROVED photo, inside the scope, and logs it as removed', async () => {
    const db = fakeDb([[PHOTO_ROW], []]);
    const result = await unpublishPhoto(db, AMBASSADOR, PHOTO, fakeFiles(db.events), REASON);

    expect(result.applied).toBe(true);
    const [update, log] = db.statements;
    expect(update?.sql).toMatch(/UPDATE facility_photos/i);
    expect(update?.sql).toMatch(/SET status = 'rejected'/);
    expect(update?.sql).toMatch(/p\.status = 'approved'/);
    expect(update?.sql).toMatch(/ambassador_municipalities/);
    expect(log?.sql).toMatch(/INSERT INTO moderation_decisions/i);
    // 'removed', not 'rejected': "it was public and we withdrew it" must stay
    // distinguishable from "it never went out" (migration 0032).
    expect(log?.params).toContain('removed');
    expect(log?.params).not.toContain('rejected');
    // A takedown has no queue: queued_at is the transaction's own now(), not
    // the upload time, so it cannot masquerade as a months-long queue wait.
    expect(log?.sql).toMatch(/now\(\)/);
    expect(log?.params).not.toContain(PHOTO_ROW.created_at);
    expect(db.events).toEqual(['commit', `delete ${STORED}`]);
  });

  it('changes, logs and deletes nothing outside the scope', async () => {
    const db = fakeDb([[]]);
    const result = await unpublishPhoto(db, AMBASSADOR, PHOTO, fakeFiles(db.events), REASON);

    expect(result.applied).toBe(false);
    expect(db.statements).toHaveLength(1);
    expect(db.text()).not.toMatch(/moderation_decisions/);
    expect(db.events.filter((e) => e.startsWith('delete'))).toEqual([]);
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
    const result = await decideFacility(db, AMBASSADOR, FACILITY, 'gone', 'duplicate');

    expect(result.applied).toBe(false);
    expect(db.text()).not.toMatch(/facility_edits|moderation_decisions/);
  });

  it('logs why a facility was marked gone, and returns the row for the statement of reasons', async () => {
    const db = fakeDb([
      [{ id: FACILITY, created_at: '2026-07-19T08:00:00Z', municipality_id: 5 }],
      [],
      [{ id: 42 }],
    ]);
    const result = await decideFacility(db, AMBASSADOR, FACILITY, 'gone', 'does_not_exist');

    expect(result).toEqual({ applied: true, decisionId: 42 });
    const log = db.statements[2];
    expect(log?.sql).toMatch(/INSERT INTO moderation_decisions[\s\S]*reason/i);
    expect(log?.params).toContain('does_not_exist');
  });

  it('refuses to mark a facility gone without a reason from the vocabulary', async () => {
    for (const reason of [null, '', 'because I said so', 'identifiable_person']) {
      const db = fakeDb([[{ id: FACILITY, created_at: '2026-07-19T08:00:00Z' }]]);
      const result = await decideFacility(db, AMBASSADOR, FACILITY, 'gone', reason);
      expect(result.applied, String(reason)).toBe(false);
      // Not even the UPDATE: an unexplained removal is not a decision we take.
      expect(db.statements, String(reason)).toHaveLength(0);
    }
  });

  it('needs no reason to verify', async () => {
    const db = fakeDb([
      [{ id: FACILITY, created_at: '2026-07-19T08:00:00Z', municipality_id: 5 }],
      [],
      [{ id: 7 }],
    ]);
    const result = await decideFacility(db, AMBASSADOR, FACILITY, 'verified', 'duplicate');
    expect(result.applied).toBe(true);
    // A stray reason on an approval is dropped, not logged against it.
    expect(db.statements[2]?.params).not.toContain('duplicate');
  });
});

describe('a refused photo carries its reason', () => {
  it('logs the reason with the rejection', async () => {
    const db = fakeDb([[PHOTO_ROW], [{ id: 9 }]]);
    const result = await decidePhoto(
      db,
      AMBASSADOR,
      PHOTO,
      'rejected',
      fakeFiles(db.events),
      'identifiable_person',
    );

    expect(result).toEqual({ applied: true, decisionId: 9 });
    expect(db.statements[1]?.params).toContain('identifiable_person');
  });

  it('refuses a rejection without a valid reason, before touching the photo or its file', async () => {
    for (const reason of [null, 'not_a_reason', 'duplicate']) {
      const db = fakeDb([[PHOTO_ROW], [{ id: 9 }]]);
      const result = await decidePhoto(
        db,
        AMBASSADOR,
        PHOTO,
        'rejected',
        fakeFiles(db.events),
        reason,
      );
      expect(result.applied, String(reason)).toBe(false);
      expect(db.statements, String(reason)).toHaveLength(0);
      expect(db.events, String(reason)).toEqual([]);
    }
  });

  it('logs no reason against an approval', async () => {
    const db = fakeDb([[PHOTO_ROW], [{ id: 3 }]]);
    await decidePhoto(db, AMBASSADOR, PHOTO, 'approved', fakeFiles(db.events), 'identifiable_person');
    expect(db.statements[1]?.params).not.toContain('identifiable_person');
  });
});

describe('a taken-down photo carries its reason', () => {
  it('logs the reason with the takedown and returns the row for the statement of reasons', async () => {
    const db = fakeDb([[PHOTO_ROW], [{ id: 11 }]]);
    const result = await unpublishPhoto(
      db,
      AMBASSADOR,
      PHOTO,
      fakeFiles(db.events),
      'not_uploaders_rights',
    );
    expect(result).toEqual({ applied: true, decisionId: 11 });
    expect(db.statements[1]?.params).toContain('not_uploaders_rights');
  });

  it('withdraws nothing — row, log or file — without a valid reason', async () => {
    for (const reason of [null, '', 'does_not_exist']) {
      const db = fakeDb([[PHOTO_ROW], [{ id: 11 }]]);
      const result = await unpublishPhoto(db, AMBASSADOR, PHOTO, fakeFiles(db.events), reason);
      expect(result.applied, String(reason)).toBe(false);
      expect(db.statements, String(reason)).toHaveLength(0);
      expect(db.events, String(reason)).toEqual([]);
    }
  });
});

describe('isRefusal', () => {
  it('is true exactly for the decisions that restrict content', () => {
    expect(isRefusal('rejected')).toBe(true);
    expect(isRefusal('removed')).toBe(true);
    expect(isRefusal('gone')).toBe(true);
    for (const other of ['approved', 'verified', 'reviewed', 'dismissed']) {
      expect(isRefusal(other)).toBe(false);
    }
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

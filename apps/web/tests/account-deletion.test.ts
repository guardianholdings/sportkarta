import { renderSql, type SQL } from '@sportkarta/db';
import { describe, expect, it } from 'vitest';

import { deleteAccount } from '@/lib/account-deletion';

/**
 * GDPR erasure, asserted at the statement level: the profile goes, the audit
 * log stays. See apps/web/lib/account-deletion.ts and the DB-backed companion
 * test in db/src/auth-schema.test.ts, which proves the same thing against real
 * Postgres constraints and triggers.
 */

function fakeDb(counts: {
  audit: number;
  photos: number;
  conditions?: number;
  points?: number;
  decisions?: number;
}) {
  const statements: { sql: string; params: unknown[] }[] = [];
  // Counts are answered in the order deleteAccount asks for them.
  const answers = [
    counts.audit,
    counts.photos,
    counts.conditions ?? 0,
    counts.points ?? 0,
    counts.decisions ?? 0,
  ];
  let selects = 0;
  const runner = {
    execute(query: SQL) {
      const rendered = renderSql(query);
      statements.push(rendered);
      if (/SELECT count/i.test(rendered.sql)) {
        const value = answers[selects] ?? 0;
        selects += 1;
        return Promise.resolve({ rows: [{ n: value }] });
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

describe('deleteAccount', () => {
  it('deletes the profile and reports what it preserved', async () => {
    const db = fakeDb({ audit: 7, photos: 2, conditions: 3, points: 5, decisions: 6 });
    const summary = await deleteAccount(db, 'user_1');

    expect(summary).toEqual({
      userId: 'user_1',
      auditRowsPreserved: 7,
      photosAnonymized: 2,
      conditionReportsAnonymized: 3,
      pointsErased: 5,
      moderationDecisionsPreserved: 6,
    });
    const text = db.statements.map((s) => s.sql).join('\n');
    expect(text).toMatch(/DELETE FROM users/i);
    expect(text).toMatch(/INSERT INTO account_deletions/i);
    // Pending one-time codes are keyed by email, so the cascade misses them.
    expect(text).toMatch(/DELETE FROM verifications/i);
  });

  it('never mutates the append-only audit log', async () => {
    const db = fakeDb({ audit: 7, photos: 0 });
    await deleteAccount(db, 'user_1');

    for (const { sql } of db.statements) {
      const touchesEdits = /facility_edits/i.test(sql);
      if (!touchesEdits) continue;
      // The only permitted contact with facility_edits is counting.
      expect(sql).toMatch(/^\s*SELECT count/i);
      expect(sql).not.toMatch(/UPDATE|DELETE|TRUNCATE/i);
    }
  });

  it('writes a tombstone that contains no personal data', async () => {
    const db = fakeDb({ audit: 1, photos: 0, conditions: 2, points: 4, decisions: 3 });
    await deleteAccount(db, 'user_1');

    const insert = db.statements.find((s) => /INSERT INTO account_deletions/i.test(s.sql));
    expect(insert).toBeDefined();
    // Only the opaque id and counts — no email, no display name. Points and
    // condition reports are evidenced too: both leave or are anonymised, so the
    // tombstone would otherwise be silent about them.
    expect(insert?.params).toEqual(['user_1', 1, 0, 2, 4, 3]);
    expect(insert?.sql).not.toMatch(/email|display_name/i);
  });

  it('runs everything in a single transaction', async () => {
    let opened = 0;
    const inner = { execute: () => Promise.resolve({ rows: [{ n: 0 }] }) };
    const db = {
      execute: inner.execute,
      transaction<T>(callback: (tx: typeof inner) => Promise<T>): Promise<T> {
        opened += 1;
        return callback(inner);
      },
    };
    await deleteAccount(db, 'user_1');
    expect(opened).toBe(1);
  });
});

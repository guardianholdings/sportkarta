import { renderSql, type SQL } from '@sportkarta/db';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

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
  rsvps?: number;
  checkins?: number;
  sessions?: number;
  digest?: number;
  results?: number;
  badges?: number;
  campaignResults?: number;
  sessionNotifications?: number;
}) {
  const statements: { sql: string; params: unknown[] }[] = [];
  // Counts are answered in the order deleteAccount asks for them.
  const answers = [
    counts.audit,
    counts.photos,
    counts.conditions ?? 0,
    counts.points ?? 0,
    counts.decisions ?? 0,
    counts.rsvps ?? 0,
    counts.checkins ?? 0,
    counts.sessions ?? 0,
    counts.digest ?? 0,
    counts.results ?? 0,
    counts.badges ?? 0,
    counts.campaignResults ?? 0,
    counts.sessionNotifications ?? 0,
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
    const db = fakeDb({
      audit: 7,
      photos: 2,
      conditions: 3,
      points: 5,
      decisions: 6,
      rsvps: 8,
      checkins: 9,
      sessions: 4,
      digest: 2,
      results: 11,
      badges: 10,
      campaignResults: 12,
      sessionNotifications: 13,
    });
    const summary = await deleteAccount(db, 'user_1');

    expect(summary).toEqual({
      userId: 'user_1',
      auditRowsPreserved: 7,
      photosAnonymized: 2,
      conditionReportsAnonymized: 3,
      pointsErased: 5,
      moderationDecisionsPreserved: 6,
      rsvpsErased: 8,
      checkinsErased: 9,
      sessionsCancelled: 4,
      digestSubscriptionsErased: 2,
      resultsAnonymized: 11,
      badgesErased: 10,
      campaignResultsAnonymized: 12,
      sessionNotificationsErased: 13,
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
    const db = fakeDb({
      audit: 1,
      photos: 0,
      conditions: 2,
      points: 4,
      decisions: 3,
      rsvps: 5,
      checkins: 6,
      sessions: 7,
      digest: 8,
      results: 9,
      badges: 10,
      campaignResults: 12,
      sessionNotifications: 13,
    });
    await deleteAccount(db, 'user_1');

    const insert = db.statements.find((s) => /INSERT INTO account_deletions/i.test(s.sql));
    expect(insert).toBeDefined();
    // Only the opaque id and counts — no email, no display name. Points,
    // condition reports and the play layer are evidenced too: each of them
    // leaves, is anonymised or is cancelled, so the tombstone would otherwise
    // be silent about them.
    expect(insert?.params).toEqual(['user_1', 1, 0, 2, 4, 3, 7, 5, 6, 8, 9, 10, 12, 13]);
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

describe('deleteAccount — an organiser’s members are told', () => {
  /**
   * The play_sessions_orphan_cancel trigger cancels an erased organiser's
   * series SILENTLY. Everyone holding an RSVP used to get no cancellation and
   * no more reminders, and turned up to a session that no longer existed. The
   * erasure now hands each cancelled series to the same `series_cancelled`
   * notification the organiser's own cancel button sends.
   */
  function organiserDb(sessionIds: string[], options: { failOnDelete?: boolean } = {}) {
    const order: string[] = [];
    const runner = {
      execute(query: SQL) {
        const { sql } = renderSql(query);
        if (/FROM play_sessions/i.test(sql)) {
          return Promise.resolve({ rows: [{ n: sessionIds.length, ids: sessionIds }] });
        }
        if (/DELETE FROM users/i.test(sql)) {
          if (options.failOnDelete) return Promise.reject(new Error('rolled back'));
          order.push('commit');
        }
        return Promise.resolve({ rows: [{ n: 0 }] });
      },
    };
    return {
      order,
      ...runner,
      transaction<T>(callback: (tx: typeof runner) => Promise<T>): Promise<T> {
        return callback(runner);
      },
    };
  }

  it('enqueues series_cancelled for every series the erasure cancelled, after the commit', async () => {
    const ids = ['8e4a1b8c-0d7e-4a8e-9c35-2b8f0c9d1e21', '0b6f3a54-7c1d-4f7e-8a2b-9d3c5e7f1a02'];
    const db = organiserDb(ids);
    const sent: { queue: string; data: Record<string, unknown> }[] = [];
    const summary = await deleteAccount(db, 'user_1', {
      enqueue: (queue, data) => {
        db.order.push('enqueue');
        sent.push({ queue, data });
        return Promise.resolve();
      },
    });

    expect(summary.sessionsCancelled).toBe(2);
    expect(sent).toEqual(
      ids.map((sessionId) => ({
        queue: 'session.notify',
        data: { reason: 'series_cancelled', sessionId },
      })),
    );
    // Session ids only — the payload names nobody.
    expect(JSON.stringify(sent)).not.toMatch(/user_1|@/);
    expect(db.order).toEqual(['commit', 'enqueue', 'enqueue']);
  });

  it('enqueues nothing for an erasure that did not commit', async () => {
    const db = organiserDb(['8e4a1b8c-0d7e-4a8e-9c35-2b8f0c9d1e21'], { failOnDelete: true });
    const enqueue = vi.fn(() => Promise.resolve());
    await expect(deleteAccount(db, 'user_1', { enqueue })).rejects.toThrow('rolled back');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues nothing for a member who organised nothing', async () => {
    const enqueue = vi.fn(() => Promise.resolve());
    await deleteAccount(organiserDb([]), 'user_1', { enqueue });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('is wired into the profile erasure action', () => {
    const action = readFileSync(
      new URL('../app/[locale]/profil/actions.ts', import.meta.url),
      'utf8',
    );
    expect(action).toMatch(/deleteAccount\(getDb\(\), user\.id, \{\s*enqueue:/);
  });
});

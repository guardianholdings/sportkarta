import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderSql, type SQL } from '@sportkarta/db';
import { describe, expect, it } from 'vitest';

import {
  eraseAccountAsAdmin,
  forcePassportPrivate,
  resetDisplayName,
  revokeSessions,
  suspendAccount,
  SUSPENSION_REASON_MAX,
  unsuspendAccount,
} from '@/lib/account-controls';

/**
 * The operator's account controls (0033), asserted at the statement level. The
 * DB-backed companion (db/src/account-suspension.test.ts) proves the CHECKs and
 * the append-only trigger these rely on against real Postgres.
 *
 * What must hold, and is asserted below:
 *  - a suspension forces the passport private IN THE SAME STATEMENT and ends
 *    every session, in one transaction with its log row;
 *  - the log row never carries the reason or a name (append-only rows survive
 *    erasure, so free text there could never be scrubbed);
 *  - an admin account is out of reach, and a no-op logs nothing;
 *  - erasure demands the member's real email, read from the database.
 */

const ADMIN = 'user_admin';
const MEMBER = 'user_member';

function fakeDb(responses: Record<string, unknown>[][] = []) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const queue = [...responses];
  const runner = {
    execute(query: SQL) {
      statements.push(renderSql(query));
      return Promise.resolve({ rows: queue.shift() ?? [] });
    },
  };
  let transactions = 0;
  return {
    statements,
    ...runner,
    transaction<T>(callback: (tx: typeof runner) => Promise<T>): Promise<T> {
      transactions += 1;
      return callback(runner);
    },
    transactions: () => transactions,
    logRows() {
      return statements.filter((s) => /INSERT INTO admin_actions/i.test(s.sql));
    },
    mutations() {
      return statements.filter((s) => /^\s*(UPDATE|DELETE|INSERT)/i.test(s.sql));
    },
  };
}

function subject(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { role: 'user', suspended: false, is_public: false, has_name: true, ...overrides };
}

describe('suspendAccount', () => {
  it('suspends, forces the passport private in the same statement, ends sessions, logs', async () => {
    const db = fakeDb([[subject({ is_public: true })], [], [{ id: 's1' }, { id: 's2' }], []]);
    const result = await suspendAccount(db, ADMIN, MEMBER, '  спам в редакциите  ');

    expect(result).toEqual({ ok: true, changed: true });
    expect(db.transactions()).toBe(1);
    const [lock, update, sessions, log] = db.statements;
    expect(lock?.sql).toMatch(/FOR UPDATE/);
    // ONE statement: users_suspended_is_private refuses a suspended public row,
    // so the visibility cannot be a second, forgettable step.
    expect(update?.sql).toMatch(/UPDATE users/);
    expect(update?.sql).toMatch(/suspended_at = now\(\)/);
    expect(update?.sql).toMatch(/profile_visibility = 'private'/);
    expect(update?.params).toContain('спам в редакциите');
    expect(sessions?.sql).toMatch(/DELETE FROM sessions WHERE user_id/);
    expect(sessions?.params).toEqual([MEMBER]);
    expect(log?.params).toEqual([
      ADMIN,
      'account_suspended',
      MEMBER,
      JSON.stringify({ sessionsRevoked: 2, passportWasPublic: true }),
    ]);
  });

  it('never copies the reason into the append-only log', async () => {
    const db = fakeDb([[subject()], [], [], []]);
    await suspendAccount(db, ADMIN, MEMBER, 'обидно име');
    const [log] = db.logRows();
    expect(JSON.stringify(log)).not.toContain('обидно име');
  });

  it('refuses an admin account and changes nothing', async () => {
    const db = fakeDb([[subject({ role: 'admin' })]]);
    expect(await suspendAccount(db, ADMIN, 'other_admin', 'x')).toEqual({
      ok: false,
      reason: 'is_admin',
    });
    expect(db.mutations()).toHaveLength(0);
  });

  it('reports a missing account', async () => {
    const db = fakeDb([[]]);
    expect(await suspendAccount(db, ADMIN, 'ghost', 'x')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(db.mutations()).toHaveLength(0);
  });

  it('is idempotent: suspending a suspended account logs nothing', async () => {
    const db = fakeDb([[subject({ suspended: true })]]);
    expect(await suspendAccount(db, ADMIN, MEMBER, 'again')).toEqual({ ok: true, changed: false });
    expect(db.mutations()).toHaveLength(0);
  });

  it('validates the reason before touching the database', async () => {
    const blank = fakeDb();
    expect(await suspendAccount(blank, ADMIN, MEMBER, '   ')).toEqual({
      ok: false,
      reason: 'reason_required',
    });
    expect(blank.statements).toHaveLength(0);

    const long = fakeDb();
    expect(
      await suspendAccount(long, ADMIN, MEMBER, 'x'.repeat(SUSPENSION_REASON_MAX + 1)),
    ).toEqual({ ok: false, reason: 'reason_too_long' });
    expect(long.statements).toHaveLength(0);
  });
});

describe('unsuspendAccount', () => {
  it('clears the suspension and its reason together, and logs it', async () => {
    const db = fakeDb([[subject({ suspended: true })], [], []]);
    expect(await unsuspendAccount(db, ADMIN, MEMBER)).toEqual({ ok: true, changed: true });
    const update = db.statements[1];
    expect(update?.sql).toMatch(/suspended_at = NULL, suspended_reason = NULL/);
    // Lifting a suspension re-publishes nothing: publishing is the member's act.
    expect(update?.sql).not.toMatch(/profile_visibility/);
    expect(db.logRows()[0]?.params).toEqual([ADMIN, 'account_unsuspended', MEMBER, '{}']);
  });

  it('does nothing for an account that is not suspended', async () => {
    const db = fakeDb([[subject()]]);
    expect(await unsuspendAccount(db, ADMIN, MEMBER)).toEqual({ ok: true, changed: false });
    expect(db.mutations()).toHaveLength(0);
  });
});

describe('resetDisplayName', () => {
  it('clears the name and withdraws a public passport in one statement', async () => {
    const db = fakeDb([[subject({ is_public: true })], [], []]);
    expect(await resetDisplayName(db, ADMIN, MEMBER)).toEqual({ ok: true, changed: true });
    const update = db.statements[1];
    expect(update?.sql).toMatch(/display_name = '', profile_visibility = 'private'/);
    expect(db.logRows()[0]?.params).toEqual([
      ADMIN,
      'display_name_reset',
      MEMBER,
      JSON.stringify({ passportMadePrivate: true }),
    ]);
  });

  it('has nothing to do for a nameless private account', async () => {
    const db = fakeDb([[subject({ has_name: false })]]);
    expect(await resetDisplayName(db, ADMIN, MEMBER)).toEqual({ ok: true, changed: false });
    expect(db.mutations()).toHaveLength(0);
  });
});

describe('forcePassportPrivate', () => {
  it('withdraws a public passport and keeps the handle', async () => {
    const db = fakeDb([[subject({ is_public: true })], [], []]);
    expect(await forcePassportPrivate(db, ADMIN, MEMBER)).toEqual({ ok: true, changed: true });
    const update = db.statements[1];
    expect(update?.sql).toMatch(/profile_visibility = 'private'/);
    // The handle survives, like the member's own "go private", so a link they
    // shared works again the day they re-publish.
    expect(update?.sql).not.toMatch(/public_handle/);
    expect(db.logRows()[0]?.params).toEqual([ADMIN, 'passport_made_private', MEMBER, '{}']);
  });

  it('does nothing for a private passport', async () => {
    const db = fakeDb([[subject()]]);
    expect(await forcePassportPrivate(db, ADMIN, MEMBER)).toEqual({ ok: true, changed: false });
    expect(db.mutations()).toHaveLength(0);
  });
});

describe('revokeSessions', () => {
  it('deletes every session for the account and logs how many', async () => {
    const db = fakeDb([[subject()], [{ id: 'a' }, { id: 'b' }, { id: 'c' }], []]);
    expect(await revokeSessions(db, ADMIN, MEMBER)).toEqual({ ok: true, changed: true });
    expect(db.statements[1]?.params).toEqual([MEMBER]);
    expect(db.logRows()[0]?.params).toEqual([
      ADMIN,
      'sessions_revoked',
      MEMBER,
      JSON.stringify({ count: 3 }),
    ]);
  });

  it('logs nothing when there was no session to end', async () => {
    const db = fakeDb([[subject()], []]);
    expect(await revokeSessions(db, ADMIN, MEMBER)).toEqual({ ok: true, changed: false });
    expect(db.logRows()).toHaveLength(0);
  });
});

describe('eraseAccountAsAdmin', () => {
  const found = [{ role: 'user', email: 'member@example.org' }];

  it('refuses when the typed email does not match the account', async () => {
    const db = fakeDb([found]);
    expect(await eraseAccountAsAdmin(db, ADMIN, MEMBER, 'someone@example.org')).toEqual({
      ok: false,
      reason: 'confirmation_mismatch',
    });
    expect(db.mutations()).toHaveLength(0);
  });

  it('refuses an admin account', async () => {
    const db = fakeDb([[{ role: 'admin', email: 'boss@example.org' }]]);
    expect(await eraseAccountAsAdmin(db, ADMIN, 'boss', 'boss@example.org')).toEqual({
      ok: false,
      reason: 'is_admin',
    });
    expect(db.mutations()).toHaveLength(0);
  });

  it('erases through deleteAccount and records the admin who did it', async () => {
    const db = fakeDb([found]);
    const result = await eraseAccountAsAdmin(db, ADMIN, MEMBER, '  Member@Example.org ');

    expect(result.ok).toBe(true);
    const text = db.statements.map((s) => s.sql).join('\n');
    // The member's own erasure path: tombstone, then the row.
    expect(text).toMatch(/INSERT INTO account_deletions/i);
    expect(text).toMatch(/DELETE FROM users/i);
    const [log] = db.logRows();
    expect(log?.params).toEqual([ADMIN, 'account_erased', MEMBER, '{}']);
    // Logged BEFORE the row goes, inside the same transaction.
    const logAt = db.statements.findIndex((s) => /INSERT INTO admin_actions/i.test(s.sql));
    const deleteAt = db.statements.findIndex((s) => /DELETE FROM users/i.test(s.sql));
    expect(logAt).toBeGreaterThan(-1);
    expect(logAt).toBeLessThan(deleteAt);
  });
});

describe('the account controls, by source', () => {
  const WEB_ROOT = join(__dirname, '..');
  const strip = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');

  it('can only ever make a passport private, and never touch a consent', () => {
    const code = strip(readFileSync(join(WEB_ROOT, 'lib', 'account-controls.ts'), 'utf8'));
    // Publishing is the member's own act (lib/passport.ts). Every visibility
    // write here — every SET clause of every UPDATE — must be the literal
    // 'private'. (Reads may compare against 'public'; only writes matter.)
    const updates = code.match(/UPDATE users[\s\S]*?WHERE/g) ?? [];
    expect(updates.length).toBeGreaterThanOrEqual(4);
    const writes = updates.flatMap((statement) =>
      [...statement.matchAll(/profile_visibility\s*=\s*('?\w+'?)/g)].map((m) => m[1]),
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const value of writes) expect(value).toBe("'private'");
    for (const statement of updates) expect(statement).not.toContain("'public'");
    // Withdrawing a training consent DELETES the data it covers; a bare admin
    // flag-flip would leave Art. 9 rows behind it.
    for (const column of ['training_route_consent_at', 'training_health_consent_at']) {
      expect(code).not.toContain(column);
    }
  });

  it('treats a suspended account as signed out in getCurrentUser', () => {
    const code = strip(readFileSync(join(WEB_ROOT, 'lib', 'auth-session.ts'), 'utf8'));
    const body = code.slice(code.indexOf('export async function getCurrentUser'));
    const query = body.slice(0, body.indexOf('export async function requireUser'));
    expect(query).toMatch(/FROM users WHERE id = \$\{userId\} AND suspended_at IS NULL/);
  });

  it('re-checks the admin role in every account action', () => {
    const code = strip(
      readFileSync(
        join(WEB_ROOT, 'app', '[locale]', 'admin', '(protected)', 'akaunti', '[id]', 'actions.ts'),
        'utf8',
      ),
    );
    const actions = code.match(/export async function \w+/g) ?? [];
    const gates = code.match(/await requireRole\(\s*'admin'\s*\)/g) ?? [];
    expect(actions.length).toBeGreaterThanOrEqual(6);
    expect(gates.length).toBe(actions.length);
    expect(code).not.toMatch(/\brequireAdmin\s*\(/);
  });
});

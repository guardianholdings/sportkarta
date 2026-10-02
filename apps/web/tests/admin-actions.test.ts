import { readFileSync } from 'node:fs';
import path from 'node:path';

import { renderSql, type SQL } from '@sportkarta/db';
import { adminAction } from '@sportkarta/db/schema';
import { describe, expect, it } from 'vitest';

import { recordAdminAction, SUBJECTLESS_ACTIONS, AMBASSADOR_ACTIONS } from '@/lib/admin-actions';

/**
 * The admin_actions log (0033): who CHANGED what.
 *
 * The migration, the Drizzle schema and lib/admin-actions.ts each state which
 * actions exist and which of them have no account as their subject. Three
 * copies of one rule drift unless something compares them — this file does.
 */

const REPO_ROOT = path.join(process.cwd(), '..', '..');
const MIGRATION = readFileSync(
  path.join(REPO_ROOT, 'db', 'migrations', '0033_account_suspension_admin_log.sql'),
  'utf8',
);

function capture() {
  const statements: { sql: string; params: unknown[] }[] = [];
  return {
    statements,
    execute(query: SQL) {
      statements.push(renderSql(query));
      return Promise.resolve({ rows: [] });
    },
  };
}

describe('recordAdminAction', () => {
  it('writes the account as subject for an account action', async () => {
    const db = capture();
    await recordAdminAction(db, 'admin_1', {
      action: 'sessions_revoked',
      subjectId: 'user_1',
      detail: { count: 2 },
    });
    const [row] = db.statements;
    expect(row?.sql).toMatch(/INSERT INTO admin_actions \(actor_id, action, subject_id, detail\)/);
    expect(row?.params).toEqual(['admin_1', 'sessions_revoked', 'user_1', '{"count":2}']);
  });

  it('writes NULL as subject for a national switch', async () => {
    const db = capture();
    await recordAdminAction(db, 'admin_1', {
      action: 'setting_changed',
      detail: { key: 'public_show_paid', value: 'true' },
    });
    expect(db.statements[0]?.params).toEqual([
      'admin_1',
      'setting_changed',
      null,
      JSON.stringify({ key: 'public_show_paid', value: 'true' }),
    ]);
  });
});

describe('the three copies of the action vocabulary agree', () => {
  it('declares the same enum in the migration and the Drizzle schema', () => {
    const match = /CREATE TYPE "public"\."admin_action" AS ENUM\(([^)]*)\)/.exec(MIGRATION);
    const declared = (match?.[1] ?? '').split(',').map((value) => value.trim().replace(/'/g, ''));
    expect(declared).toEqual([...adminAction.enumValues]);
  });

  it('names the same subjectless actions in the CHECK and in the writer', () => {
    const match = /"admin_actions_subject_matches_action" CHECK \(.*?IN \(([^)]*)\)/.exec(
      MIGRATION,
    );
    const inCheck = (match?.[1] ?? '').split(',').map((value) => value.trim().replace(/'/g, ''));
    expect(inCheck.sort()).toEqual([...SUBJECTLESS_ACTIONS].sort());
  });

  it('only filters by actions that exist', () => {
    for (const action of [...SUBJECTLESS_ACTIONS, ...AMBASSADOR_ACTIONS]) {
      expect(adminAction.enumValues).toContain(action);
    }
  });
});

describe('the national switches are logged', () => {
  it('writes a log row from both private-venue actions, only when the value changed', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'app/[locale]/admin/(protected)/chastni/actions.ts'),
      'utf8',
    );
    expect(source.match(/recordAdminAction\(tx, admin\.id/g)).toHaveLength(2);
    // "Write the target state" stays idempotent: a double submit matches no row
    // and therefore logs no second decision.
    expect(source.match(/IS DISTINCT FROM/g)).toHaveLength(2);
    expect(source.match(/await requireRole\('admin'\)/g)).toHaveLength(2);
  });
});

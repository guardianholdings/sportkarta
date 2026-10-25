import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { renderSql, type SQL } from '@sportkarta/db';
import { adminAction } from '@sportkarta/db/schema';
import { describe, expect, it } from 'vitest';

import {
  AMBASSADOR_ACTIONS,
  CLUB_ACTIONS,
  recordAdminAction,
  SUBJECTLESS_ACTIONS,
} from '@/lib/admin-actions';

/**
 * The admin_actions log (0033): who CHANGED what.
 *
 * The migration, the Drizzle schema and lib/admin-actions.ts each state which
 * actions exist and which of them have no account as their subject. Three
 * copies of one rule drift unless something compares them — this file does.
 */

const REPO_ROOT = path.join(process.cwd(), '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'db', 'migrations');
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const MIGRATION = readFileSync(
  path.join(MIGRATIONS_DIR, '0033_account_suspension_admin_log.sql'),
  'utf8',
);

/**
 * The CURRENT vocabulary as the migrations build it: 0033's CREATE TYPE plus
 * every later `ADD VALUE`, in file order (0038 added the club actions).
 */
function migratedEnumValues(): string[] {
  const created = /CREATE TYPE "public"\."admin_action" AS ENUM\(([^)]*)\)/.exec(MIGRATION);
  const values = (created?.[1] ?? '').split(',').map((value) => value.trim().replace(/'/g, ''));
  for (const file of MIGRATION_FILES) {
    const source = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    for (const match of source.matchAll(
      /ALTER TYPE "public"\."admin_action" ADD VALUE IF NOT EXISTS '([a-z_]+)'/g,
    )) {
      if (match[1] && !values.includes(match[1])) values.push(match[1]);
    }
  }
  return values;
}

/** The subjectless list from the NEWEST migration that (re)defines the CHECK. */
function migratedSubjectlessActions(): string[] {
  let latest = '';
  for (const file of MIGRATION_FILES) {
    const source = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').replace(/^--.*$/gm, '');
    const match = /"admin_actions_subject_matches_action" CHECK \([\s\S]*?IN \(([^)]*)\)/.exec(
      source,
    );
    if (match?.[1]) latest = match[1];
  }
  return latest
    .split(',')
    .map((value) => value.trim().replace(/'/g, ''))
    .filter(Boolean);
}

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
  it('declares the same enum in the migrations and the Drizzle schema', () => {
    expect(migratedEnumValues()).toEqual([...adminAction.enumValues]);
  });

  it('names the same subjectless actions in the newest CHECK and in the writer', () => {
    expect(migratedSubjectlessActions().sort()).toEqual([...SUBJECTLESS_ACTIONS].sort());
  });

  it('only filters by actions that exist', () => {
    for (const action of [...SUBJECTLESS_ACTIONS, ...AMBASSADOR_ACTIONS, ...CLUB_ACTIONS]) {
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

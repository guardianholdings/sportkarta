import { renderSql, type SQL } from '@sportkarta/db';
import { describe, expect, it } from 'vitest';

import { canAccessAdminPanel, hasAtLeast, syncAdminRole, toRole } from '@/lib/roles';

function recordingDb() {
  const statements: { sql: string; params: unknown[] }[] = [];
  return {
    statements,
    execute(query: SQL) {
      statements.push(renderSql(query));
      return Promise.resolve({ rows: [] });
    },
  };
}

describe('role ranks', () => {
  it('orders user < ambassador < admin', () => {
    expect(hasAtLeast('admin', 'ambassador')).toBe(true);
    expect(hasAtLeast('ambassador', 'ambassador')).toBe(true);
    expect(hasAtLeast('ambassador', 'admin')).toBe(false);
    expect(hasAtLeast('user', 'ambassador')).toBe(false);
  });

  it('treats the retired moderator role as no privileges at all', () => {
    // Stage 3.3 retired it. A stale row must fail closed rather than inherit
    // whatever rank happens to sort next to it.
    expect(toRole('moderator')).toBe('user');
    expect(hasAtLeast('moderator', 'ambassador')).toBe(false);
    expect(canAccessAdminPanel('moderator')).toBe(false);
  });

  it('fails closed on unknown, missing or spoofed role values', () => {
    for (const value of [undefined, null, '', 'superadmin', 'ADMIN', 42, {}]) {
      expect(toRole(value)).toBe('user');
      expect(hasAtLeast(value, 'ambassador')).toBe(false);
      expect(canAccessAdminPanel(value)).toBe(false);
    }
  });

  it('lets ambassadors into the admin panel but not plain members', () => {
    expect(canAccessAdminPanel('admin')).toBe(true);
    expect(canAccessAdminPanel('ambassador')).toBe(true);
    expect(canAccessAdminPanel('user')).toBe(false);
  });
});

describe('syncAdminRole', () => {
  it('promotes an allowlisted account and demotes one that was removed', async () => {
    const db = recordingDb();
    await syncAdminRole(db, 'user_1', new Set(['pavel@example.org', 'maria@example.org']));

    expect(db.statements).toHaveLength(2);
    const [promote, demote] = db.statements;
    expect(promote?.sql).toMatch(/SET role = 'admin'/);
    // The allowlist must bind as ONE array parameter: interpolating a JS array
    // into drizzle's template expands it to `ANY(($1, $2)::text[])`, which
    // Postgres rejects — so assert the rendered placeholder, not just the values.
    expect(promote?.sql).toMatch(/= ANY\(\$2::text\[\]\)/);
    // Defence in depth for the day Google login is enabled: the allowlist must
    // not trust an address a provider merely asserts.
    expect(promote?.sql).toMatch(/email_verified/);
    expect(promote?.params).toEqual(['user_1', ['pavel@example.org', 'maria@example.org']]);
    expect(demote?.sql).toMatch(/SET role = 'user'/);
    // Demotion is scoped to the admin role only: ambassador grants and their
    // municipality scope are managed in-app and must survive an
    // ADMIN_EMAILS change.
    expect(demote?.sql).toMatch(/role = 'admin'/);
    expect(demote?.sql).not.toMatch(/ambassador/);
  });

  it('does nothing at all when the allowlist is empty', async () => {
    // A dropped environment variable must not silently demote every admin.
    const db = recordingDb();
    await syncAdminRole(db, 'user_1', new Set());
    expect(db.statements).toEqual([]);
  });

  it('scopes every statement to the one account signing in', async () => {
    const db = recordingDb();
    await syncAdminRole(db, 'user_1', new Set(['a@b.bg']));
    for (const statement of db.statements) {
      expect(statement.sql).toMatch(/WHERE id = \$1/);
      expect(statement.params[0]).toBe('user_1');
    }
  });
});

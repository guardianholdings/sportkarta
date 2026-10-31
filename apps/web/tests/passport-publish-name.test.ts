import type { SQL } from '@sportkarta/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Publishing a passport WITH a name (UX audit, «Publish passport»): a member
 * with none types it beside the button, and the name and the publish are one
 * transaction — six taps through /profil became one form. The publish still
 * re-reads the name from the database (lib/passport.ts), so this cannot
 * publish under a blank one.
 */
const h = vi.hoisted(() => ({
  statements: [] as { sql: string; params: unknown[] }[],
  transactions: 0,
  /** What `readVisibility` sees: a name only once one was saved. */
  named: false,
}));

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/auth-session', () => ({ requireUser: () => Promise.resolve({ id: 'u-7' }) }));
vi.mock('@sportkarta/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sportkarta/db')>();
  const runner = {
    execute(query: SQL) {
      const statement = actual.renderSql(query);
      h.statements.push(statement);
      if (statement.sql.includes('SET display_name')) h.named = true;
      if (statement.sql.includes('AS has_name')) {
        return Promise.resolve({
          rows: [{ profile_visibility: 'private', public_handle: null, has_name: h.named }],
        });
      }
      return Promise.resolve({ rows: [{ public_handle: 'abc' }] });
    },
  };
  return {
    ...actual,
    getDb: () => ({
      ...runner,
      async transaction<T>(run: (tx: typeof runner) => Promise<T>): Promise<T> {
        h.transactions += 1;
        return run(runner);
      },
    }),
  };
});

const { setPassportVisibilityAction } = await import('@/app/[locale]/pasport/actions');

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  h.statements.length = 0;
  h.transactions = 0;
  h.named = false;
});

describe('publishing a passport with a name', () => {
  it('saves the name, then publishes, in one transaction', async () => {
    const result = await setPassportVisibilityAction(
      { error: null },
      form({ isPublic: 'true', showActivity: 'false', displayName: '  Ани  ' }),
    );
    expect(result).toEqual({ error: null });
    expect(h.transactions).toBe(1);
    const sqls = h.statements.map((s) => s.sql);
    const nameAt = sqls.findIndex((s) => s.includes('SET display_name'));
    const publishAt = sqls.findIndex((s) => s.includes('profile_visibility ='));
    expect(nameAt).toBeGreaterThanOrEqual(0);
    expect(publishAt).toBeGreaterThan(nameAt);
    expect(h.statements[nameAt]?.params[0]).toBe('Ани');
  });

  it('refuses a blank name before writing anything', async () => {
    const result = await setPassportVisibilityAction(
      { error: null },
      form({ isPublic: 'true', showActivity: 'false', displayName: '   ' }),
    );
    expect(result).toEqual({ error: 'name_required' });
    expect(h.statements).toHaveLength(0);
  });

  it('says a long name is too long', async () => {
    const result = await setPassportVisibilityAction(
      { error: null },
      form({ isPublic: 'true', showActivity: 'false', displayName: 'я'.repeat(61) }),
    );
    expect(result).toEqual({ error: 'name_too_long' });
  });

  it('still refuses to publish a nameless passport with no name sent', async () => {
    const result = await setPassportVisibilityAction(
      { error: null },
      form({ isPublic: 'true', showActivity: 'false' }),
    );
    expect(result).toEqual({ error: 'name_required' });
    expect(h.statements.some((s) => s.sql.includes('profile_visibility ='))).toBe(false);
  });
});

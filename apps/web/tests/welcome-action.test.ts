import { renderSql, type SQL } from '@sportkarta/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The first-run name step (app/[locale]/dobre-doshli): one name, saved by the
 * profile's own rules, then on to where the member was going. A refused name
 * comes back to the step, never to a bare error.
 */
const h = vi.hoisted(() => {
  class Redirected extends Error {
    constructor(readonly target: unknown) {
      super('NEXT_REDIRECT');
    }
  }
  return { Redirected, statements: [] as { sql: string; params: unknown[] }[], name: '' };
});

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/i18n/navigation', () => ({
  redirect: (target: unknown) => {
    throw new h.Redirected(target);
  },
}));
vi.mock('@/lib/auth-session', () => ({
  requireUser: () => Promise.resolve({ id: 'u-1', displayName: h.name, homeCity: null }),
}));
vi.mock('@sportkarta/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sportkarta/db')>();
  return {
    ...actual,
    getDb: () => ({
      execute(query: SQL) {
        h.statements.push(renderSql(query));
        return Promise.resolve({ rows: [] });
      },
    }),
  };
});

const { welcomeAction } = await import('@/app/[locale]/dobre-doshli/actions');

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function target(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof h.Redirected) return error.target;
    throw error;
  }
  throw new Error('expected a redirect');
}

beforeEach(() => {
  h.statements.length = 0;
  h.name = '';
});

describe('welcomeAction', () => {
  it('saves the name and the city, then goes on to `next`', async () => {
    expect(
      await target(
        welcomeAction(
          form({
            displayName: '  Мария   Петрова ',
            homeCity: 'Варна',
            next: '/dobavi',
            locale: 'en',
          }),
        ),
      ),
    ).toEqual({ href: '/dobavi', locale: 'en' });
    expect(h.statements).toHaveLength(1);
    expect(h.statements[0]?.params).toEqual(['Мария Петрова', 'Варна', 'u-1']);
  });

  it('comes back to the step with the reason when there is no name', async () => {
    expect(
      await target(welcomeAction(form({ displayName: '   ', next: '/pasport', locale: 'bg' }))),
    ).toEqual({
      href: {
        pathname: '/dobre-doshli',
        query: { next: '/pasport', greshka: 'display_name_required' },
      },
      locale: 'bg',
    });
    expect(h.statements).toHaveLength(0);
  });

  it('writes nothing for an account that already has a name', async () => {
    h.name = 'Мария';
    expect(
      await target(welcomeAction(form({ displayName: 'Друго', next: '/dobavi', locale: 'bg' }))),
    ).toEqual({ href: '/dobavi', locale: 'bg' });
    expect(h.statements).toHaveLength(0);
  });

  it('never goes off the site, whatever `next` says', async () => {
    expect(
      await target(
        welcomeAction(form({ displayName: 'Иван', next: '//evil.example', locale: 'bg' })),
      ),
    ).toEqual({ href: '/profil', locale: 'bg' });
  });
});

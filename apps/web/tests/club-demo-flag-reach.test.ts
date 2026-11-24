import type { SQL } from '@sportkarta/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requireClubPage, requireClubStaff } from '@/lib/clubs/club-session';
import { memberCard } from '@/lib/clubs/members';

/**
 * How far the demo flag reaches. With CLUBS_ENABLED and CLUBS_DEMO_ENABLED
 * both on:
 *
 *  - another club's office still sends a signed-out visitor to sign in, and
 *    gives a signed-in account without a grant there a 404;
 *  - the demo office opens view-only, without a sign-in, and closes again
 *    (404) when the demo flag is off;
 *  - the staff gate every save goes through is not opened by the flag;
 *  - another club's record, asked for inside the demo office, is not found:
 *    the loader is scoped by the club the gate returned, not by the URL.
 *
 * Only the framework, better-auth and the database are replaced. The page
 * gate, the session helpers and the scope are the real ones; the database is
 * a recorder that renders each statement and answers from a queue.
 */

// lib/clubs/club-session.ts and lib/auth-session.ts are `server-only`.
vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => {
  class NotFound extends Error {
    constructor() {
      super('NEXT_NOT_FOUND');
    }
  }
  class Redirected extends Error {
    constructor(readonly target: unknown) {
      super('NEXT_REDIRECT');
    }
  }
  return {
    NotFound,
    Redirected,
    sessionUserId: null as string | null,
    statements: [] as { sql: string; params: unknown[] }[],
    answers: [] as Record<string, unknown>[][],
  };
});

// React's per-request cache is a server feature; here every call reads afresh.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache: <T>(fn: T): T => fn,
}));
vi.mock('next/headers', () => ({
  headers: () =>
    Promise.resolve(new Headers({ 'x-sportkarta-path': '/klub/testov-klub/chlenove' })),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new h.NotFound();
  },
}));
vi.mock('next-intl/server', () => ({ getLocale: () => Promise.resolve('bg') }));
vi.mock('@/i18n/navigation', () => ({
  redirect: (target: unknown) => {
    throw new h.Redirected(target);
  },
}));
vi.mock('@/lib/auth', () => ({
  getAuth: () => ({
    api: {
      getSession: () => Promise.resolve(h.sessionUserId ? { user: { id: h.sessionUserId } } : null),
    },
  }),
}));
vi.mock('@sportkarta/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sportkarta/db')>();
  return {
    ...actual,
    getDb: () => ({
      execute(query: SQL) {
        h.statements.push(actual.renderSql(query));
        return Promise.resolve({ rows: h.answers.shift() ?? [] });
      },
    }),
  };
});

const OTHER_CLUB_ID = '11111111-1111-4111-8111-111111111111';
const DEMO_CLUB_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_CLUBS_MEMBER = '33333333-3333-4333-8333-333333333333';

/** The users row getCurrentUser reads for a signed-in account (made up). */
const accountRow = {
  id: 'user_plain',
  email: 'plain@example.test',
  display_name: 'Тест',
  home_city: null,
  is_minor: false,
  role: 'user',
};

/** A clubs row as the gate's loaders select it (made up). */
function clubRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OTHER_CLUB_ID,
    slug: 'testov-klub',
    name_bg: 'Тестов клуб',
    name_en: null,
    kind: 'gym',
    tier: 'pro',
    status: 'active',
    visible: true,
    trial_ends_on: null,
    paid_until: '2099-12-31',
    member_cap: null,
    logo_path: null,
    locale: 'bg',
    role: null,
    ...over,
  };
}

/** The demo club and its made-up owner, as loadDemoContext selects them. */
const demoRow = clubRow({
  id: DEMO_CLUB_ID,
  slug: 'demo',
  name_bg: 'Демо клуб',
  name_en: 'Demo club',
  status: 'demo',
  user_id: 'demo-club-owner',
  email: 'owner@demo.invalid',
  display_name: 'Демо',
});

beforeEach(() => {
  vi.stubEnv('CLUBS_ENABLED', 'true');
  vi.stubEnv('CLUBS_DEMO_ENABLED', 'true');
  vi.stubEnv('ADMIN_EMAILS', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  h.sessionUserId = null;
  h.statements.length = 0;
  h.answers.length = 0;
});

describe('with the demo flag on, another club’s office is unchanged', () => {
  it('sends a signed-out visitor to sign in, before any club is read', async () => {
    await expect(requireClubPage('testov-klub', 'members.view')).rejects.toMatchObject({
      message: 'NEXT_REDIRECT',
      target: { href: { pathname: '/vhod' }, locale: 'bg' },
    });
    expect(h.statements).toHaveLength(0);
  });

  it('gives a signed-in account without a grant there a 404', async () => {
    h.sessionUserId = 'user_plain';
    h.answers.push([accountRow], [clubRow({ role: null })]);
    await expect(requireClubPage('testov-klub', 'members.view')).rejects.toBeInstanceOf(h.NotFound);
    const clubRead = h.statements[1];
    expect(clubRead?.sql).toMatch(
      /LEFT JOIN club_staff s ON s\.club_id = c\.id AND s\.user_id = \$\d+/,
    );
    expect(clubRead?.params).toEqual(expect.arrayContaining(['user_plain', 'testov-klub']));
    expect(clubRead?.sql).not.toMatch(/status = 'demo'/);
  });

  it('still opens for the club’s own staff', async () => {
    h.sessionUserId = 'user_plain';
    h.answers.push([accountRow], [clubRow({ role: 'desk' })]);
    const context = await requireClubPage('testov-klub', 'members.view');
    expect(context.actor).toEqual({
      userId: 'user_plain',
      clubId: OTHER_CLUB_ID,
      role: 'desk',
      ngoAdmin: false,
    });
  });
});

describe('the demo office', () => {
  it('opens view-only without a sign-in, as its made-up owner', async () => {
    h.answers.push([demoRow]);
    const context = await requireClubPage('demo', 'members.view');
    expect(context.actor).toEqual({
      userId: 'demo-club-owner',
      clubId: DEMO_CLUB_ID,
      role: 'owner',
      ngoAdmin: false,
    });
    // One statement: no session read, and nothing written to club_audit.
    expect(h.statements).toHaveLength(1);
    expect(h.statements[0]?.sql).toMatch(/c\.slug = \$\d+ AND c\.status = 'demo'/);
    expect(h.statements[0]?.params).toContain('demo');
  });

  it('is a 404 with the demo flag off, before anything is read', async () => {
    vi.stubEnv('CLUBS_DEMO_ENABLED', 'false');
    await expect(requireClubPage('demo', 'members.view')).rejects.toBeInstanceOf(h.NotFound);
    expect(h.statements).toHaveLength(0);
  });

  it('is a 404 when no club has both the slug and the status `demo`', async () => {
    h.answers.push([]);
    await expect(requireClubPage('demo', 'members.view')).rejects.toBeInstanceOf(h.NotFound);
  });

  it('does not open the staff gate that every save goes through', async () => {
    await expect(requireClubStaff('demo', 'members.view')).rejects.toMatchObject({
      message: 'NEXT_REDIRECT',
    });
    h.sessionUserId = 'user_plain';
    h.answers.push([accountRow], [clubRow({ id: DEMO_CLUB_ID, slug: 'demo', status: 'demo' })]);
    await expect(requireClubStaff('demo', 'members.view')).rejects.toBeInstanceOf(h.NotFound);
  });

  it('does not find another club’s record: the read is scoped to the demo club', async () => {
    h.answers.push([demoRow]);
    const { actor } = await requireClubPage('demo', 'members.view');
    h.answers.push([]);
    await expect(memberCard(actor, OTHER_CLUBS_MEMBER)).resolves.toBeNull();
    const read = h.statements[1];
    expect(read?.sql).toMatch(/m\.club_id = \$\d+::uuid/);
    expect(read?.params).toEqual(expect.arrayContaining([DEMO_CLUB_ID, OTHER_CLUBS_MEMBER]));
    expect(read?.params).not.toContain(OTHER_CLUB_ID);
    // Nothing else is read once the scoped row is missing; the page then 404s.
    expect(h.statements).toHaveLength(2);
  });
});

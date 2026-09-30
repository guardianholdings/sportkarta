import { renderSql, type SQL } from '@sportkarta/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PARTNER_RENDERABLE } from '@/lib/partners';

/**
 * GET /api/partners/logo/[id]. The public branch used to check `visible` alone,
 * so a sponsor whose window had ended — or had not begun (an embargoed deal) —
 * kept its logo at a guessable numeric URL while every page denied the partner
 * existed. The public branch must embed the one rendering rule every other
 * partner surface uses; the unfiltered preview exists for the admin screen only.
 */

const rows: Record<string, unknown>[][] = [];
const statements: { sql: string; params: unknown[] }[] = [];
const currentUser = vi.fn();
const storageGet = vi.fn();

vi.mock('@sportkarta/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sportkarta/db')>()),
  getDb: () => ({
    execute(query: SQL) {
      statements.push(renderSql(query));
      return Promise.resolve({ rows: rows.shift() ?? [] });
    },
  }),
}));
vi.mock('@/lib/auth-session', () => ({ getCurrentUser: () => currentUser() }));
vi.mock('@/lib/storage', () => ({ getStorage: () => ({ get: storageGet }) }));

async function get(id: string): Promise<Response> {
  const { GET } = await import('@/app/api/partners/logo/[id]/route');
  return GET(new Request(`http://localhost/api/partners/logo/${id}`), {
    params: Promise.resolve({ id }),
  });
}

afterEach(() => {
  rows.length = 0;
  statements.length = 0;
  vi.clearAllMocks();
});

describe('GET /api/partners/logo/[id]', () => {
  it('asks for a RENDERABLE partner — visible and inside its window — not merely visible', async () => {
    rows.push([{ logo_path: 'partners/2026/09/logo.webp' }]);
    storageGet.mockResolvedValue(new Uint8Array([1]));

    const res = await get('7');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/^public/);
    const statement = statements[0]?.sql ?? '';
    expect(statement).toContain(renderSql(PARTNER_RENDERABLE).sql);
    expect(statement).toMatch(/p\.starts_on/);
    expect(statement).toMatch(/p\.ends_on/);
    expect(currentUser).not.toHaveBeenCalled();
  });

  it('refuses a lapsed or embargoed partner’s logo to the public', async () => {
    rows.push([]);
    currentUser.mockResolvedValue(null);

    const res = await get('7');
    expect(res.status).toBe(404);
    expect(statements).toHaveLength(1);
    expect(storageGet).not.toHaveBeenCalled();
  });

  it('refuses it to an ambassador too — the partner registry is admin-only', async () => {
    rows.push([]);
    currentUser.mockResolvedValue({ id: 'user_amb', role: 'ambassador' });

    expect((await get('7')).status).toBe(404);
    expect(statements).toHaveLength(1);
  });

  it('previews it to an admin, uncached, for the partner’s own admin screen', async () => {
    rows.push([], [{ logo_path: 'partners/2026/09/logo.webp' }]);
    currentUser.mockResolvedValue({ id: 'user_admin', role: 'admin' });
    storageGet.mockResolvedValue(new Uint8Array([1]));

    const res = await get('7');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});

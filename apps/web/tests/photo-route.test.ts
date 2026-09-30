import { renderSql, type SQL } from '@sportkarta/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PHOTO_PUBLIC } from '@/lib/photos';

/**
 * GET /api/photos/[id], end to end with the database, the session and the
 * volume faked: the handler must wire lib/photos.ts's rules to real responses
 * — status, bytes, and above all the cache header, since a pending photo that
 * landed in a shared cache would be published by the cache.
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

const PHOTO = '6f1c2a9e-4b7d-4c3e-9a51-0d2e8f7b6a10';
const STORED = 'facilities/2026/09/6f1c2a9e-4b7d-4c3e-9a51-0d2e8f7b6a10.webp';
const BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

async function get(id: string): Promise<Response> {
  const { GET } = await import('@/app/api/photos/[id]/route');
  return GET(new Request(`http://localhost/api/photos/${id}`), {
    params: Promise.resolve({ id }),
  });
}

afterEach(() => {
  rows.length = 0;
  statements.length = 0;
  vi.clearAllMocks();
});

describe('GET /api/photos/[id]', () => {
  it('serves an approved photo to anyone, briefly cacheable, without a session lookup', async () => {
    rows.push([{ storage_path: STORED }]);
    storageGet.mockResolvedValue(BYTES);

    const res = await get(PHOTO);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(storageGet).toHaveBeenCalledWith(STORED);
    expect(currentUser).not.toHaveBeenCalled();
    expect(statements[0]?.sql).toContain(renderSql(PHOTO_PUBLIC).sql);
  });

  it('answers 404 to an anonymous request for a pending photo, and reads no file', async () => {
    rows.push([]);
    currentUser.mockResolvedValue(null);

    const res = await get(PHOTO);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(storageGet).not.toHaveBeenCalled();
    expect(statements).toHaveLength(1);
  });

  it('shows a pending photo to an in-scope ambassador and never lets it be stored', async () => {
    rows.push([], [{ storage_path: STORED }]);
    currentUser.mockResolvedValue({ id: 'user_amb', role: 'ambassador' });
    storageGet.mockResolvedValue(BYTES);

    const res = await get(PHOTO);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(statements[1]?.sql).toMatch(/ambassador_municipalities/);
  });

  it('gives a plain member what it gives a visitor', async () => {
    rows.push([]);
    currentUser.mockResolvedValue({ id: 'user_plain', role: 'user' });

    expect((await get(PHOTO)).status).toBe(404);
    expect(statements).toHaveLength(1);
  });

  it('answers 404, not 500, when the row points at a file that is gone', async () => {
    rows.push([{ storage_path: STORED }]);
    storageGet.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const res = await get(PHOTO);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a storage key or traversal in place of an id before any work', async () => {
    const res = await get('..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(404);
    expect(statements).toHaveLength(0);
    expect(currentUser).not.toHaveBeenCalled();
    expect(storageGet).not.toHaveBeenCalled();
  });
});

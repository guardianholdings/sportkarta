import { getDb, sql } from '@sportkarta/db';

import { getStorage } from '@/lib/storage';

/**
 * Serve a partner logo. THE ROW DECIDES, NOT THE PATH (the opendata-dumps
 * rule): the URL carries only the partner id; the storage key comes from the
 * partners row, so traversal is unexpressible and a file no row points at is
 * unreachable. Only VISIBLE partners' logos are served — a draft or lapsed
 * partner's logo is not public just because its id can be guessed.
 *
 * Logos change by getting a NEW key (uuid per upload), so long caching is
 * honest: an updated logo is a different URL the moment the row changes.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!/^\d{1,12}$/.test(id)) return notFound();

  const result = await getDb().execute(sql`
    SELECT logo_path FROM partners WHERE id = ${Number(id)} AND visible AND logo_path IS NOT NULL
  `);
  const path = result.rows[0]?.logo_path;
  if (!path) return notFound();

  try {
    const data = await getStorage().get(String(path));
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    // A row pointing at a missing file is an ops problem, not a 500 the
    // public page should wear.
    return notFound();
  }
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

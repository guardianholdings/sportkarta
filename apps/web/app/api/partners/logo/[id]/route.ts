import { getDb, sql } from '@sportkarta/db';

import { getCurrentUser } from '@/lib/auth-session';
import { PARTNER_RENDERABLE } from '@/lib/partners';
import { getStorage } from '@/lib/storage';

/**
 * Serve a partner logo. THE ROW DECIDES, NOT THE PATH (the opendata-dumps
 * rule): the URL carries only the partner id; the storage key comes from the
 * partners row, so traversal is unexpressible and a file no row points at is
 * unreachable. Only RENDERABLE partners' logos are public — a draft, lapsed or
 * not-yet-started (embargoed) partner's logo is not public just because its id
 * can be guessed. That is `PARTNER_RENDERABLE`, embedded rather than restated:
 * the hand-written `visible` this used to carry forgot the window, so a
 * sponsorship that had ended, or not yet begun, kept its logo at a guessable
 * URL while every page denied the partner existed.
 *
 * The one exception is the partner's own admin screen, which previews the logo
 * of a draft or scheduled partner too. That branch requires an ADMIN (the
 * partner registry is admin-only, not ambassador) and is never cached.
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
    SELECT p.logo_path FROM partners p
     WHERE p.id = ${Number(id)} AND ${PARTNER_RENDERABLE} AND p.logo_path IS NOT NULL
  `);
  const path = result.rows[0]?.logo_path;
  if (path) return serve(String(path), 'public, max-age=86400, stale-while-revalidate=604800');

  // Not public. Only now is the session consulted, so the public case never pays for it.
  const viewer = await getCurrentUser();
  if (viewer?.role !== 'admin') return notFound();
  const preview = await getDb().execute(sql`
    SELECT p.logo_path FROM partners p WHERE p.id = ${Number(id)} AND p.logo_path IS NOT NULL
  `);
  const previewPath = preview.rows[0]?.logo_path;
  return previewPath ? serve(String(previewPath), 'private, no-store') : notFound();
}

async function serve(path: string, cacheControl: string): Promise<Response> {
  try {
    const data = await getStorage().get(path);
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': cacheControl,
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

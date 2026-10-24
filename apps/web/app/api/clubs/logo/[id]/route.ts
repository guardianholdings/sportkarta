import { getDb, sql } from '@sportkarta/db';

import { getCurrentUser } from '@/lib/auth-session';
import { clubRenderableSql, clubsEnabled } from '@/lib/clubs/access';
import { getStorage } from '@/lib/storage';

/**
 * A club's logo. THE ROW DECIDES, NOT THE PATH (the partner-logo rule): the
 * URL carries only the club id, the storage key comes from clubs.logo_path,
 * so traversal is unexpressible. Public only while the club is RENDERABLE
 * (clubRenderableSql — the same predicate the public pages embed); a pending,
 * hidden or lapsed club's logo is shown, uncached, only to its own staff and
 * to the NGO's operators. A new upload is a new key, so long caching is
 * honest for the public case.
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!clubsEnabled()) return notFound();
  const { id } = await params;
  if (!UUID.test(id)) return notFound();

  const result = await getDb().execute(sql`
    SELECT c.logo_path FROM clubs c
     WHERE c.id = ${id}::uuid AND c.logo_path IS NOT NULL AND ${clubRenderableSql('c')}
  `);
  const path = result.rows[0]?.logo_path;
  if (path) return serve(String(path), 'public, max-age=86400, stale-while-revalidate=604800');

  // Not public. Only now is the session consulted, so the public case never pays for it.
  const viewer = await getCurrentUser();
  if (!viewer) return notFound();
  const preview = await getDb().execute(sql`
    SELECT c.logo_path FROM clubs c
     WHERE c.id = ${id}::uuid AND c.logo_path IS NOT NULL
       AND (EXISTS (SELECT 1 FROM club_staff s WHERE s.club_id = c.id AND s.user_id = ${viewer.id})
            OR EXISTS (SELECT 1 FROM users u WHERE u.id = ${viewer.id} AND u.role = 'admin'))
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
    return notFound();
  }
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

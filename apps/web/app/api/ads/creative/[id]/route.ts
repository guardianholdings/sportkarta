import { getDb, sql } from '@sportkarta/db';

import { getStorage } from '@/lib/storage';

/**
 * Serve an ad creative. THE ROW DECIDES, NOT THE PATH (the opendata-dumps rule,
 * same as /api/partners/logo/[id]): the URL carries only the placement id, the
 * storage key comes from the row, so traversal is unexpressible and a file no
 * row points at is unreachable.
 *
 * The visibility predicate is REPEATED HERE, not inherited from the page that
 * embedded the ad. A creative URL is guessable and shareable, so a draft
 * placement's artwork — often a campaign under embargo — must not be fetchable
 * just because its id can be incremented. The condition is the same one
 * `activeAd` uses: the placement is visible and in its window, AND its partner
 * is visible and in theirs.
 *
 * NOTHING IS LOGGED OR COUNTED. This is the one request an ad server would
 * measure, and measuring it is exactly what §S5 sells instead of: the
 * deliverable report is page views from self-hosted Umami, never a per-creative
 * request log. There is deliberately no counter to increment here.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!/^\d{1,12}$/.test(id)) return notFound();

  const today = sql`(now() AT TIME ZONE 'Europe/Sofia')::date`;
  const result = await getDb().execute(sql`
    SELECT a.creative_path
      FROM ad_placements a
      JOIN partners p ON p.id = a.partner_id
     WHERE a.id = ${Number(id)}
       AND a.visible
       AND a.starts_on <= ${today}
       AND a.ends_on >= ${today}
       AND p.visible
       AND (p.starts_on IS NULL OR p.starts_on <= ${today})
       AND (p.ends_on IS NULL OR p.ends_on >= ${today})
  `);
  const path = result.rows[0]?.creative_path;
  if (!path) return notFound();

  try {
    const data = await getStorage().get(String(path));
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': 'image/webp',
        // A replaced creative is a new row and a new id, so caching the bytes
        // hard is honest — but a placement can be pulled mid-flight (a sponsor
        // scandal, §S1's termination clause), so this is a day, not a year.
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    // A row pointing at a missing file is an ops problem, not a 500 a public
    // page should wear.
    return notFound();
  }
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

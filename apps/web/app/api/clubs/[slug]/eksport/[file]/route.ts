import { requireClubStaff } from '@/lib/clubs/club-session';
import { clubExportCsv, exportPermission, isClubExportDataset } from '@/lib/clubs/export';

/**
 * A club's data as CSV (/api/clubs/<slug>/eksport/<dataset>.csv).
 *
 * IT GATES ITSELF: /api is outside the middleware matcher, so the staff check
 * for the dataset's permission — read from the database, 404 for everyone
 * else — is the whole gate, and the export's own statement repeats the scope.
 * Never cached: the file is one club's member data.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; file: string }> },
): Promise<Response> {
  const { slug, file } = await params;
  const dataset = /^([a-z]+)\.csv$/.exec(file)?.[1] ?? '';
  if (!/^[a-z0-9-]{3,60}$/.test(slug) || !isClubExportDataset(dataset)) {
    return new Response(null, { status: 404 });
  }
  const { actor } = await requireClubStaff(slug, exportPermission(dataset));
  const body = await clubExportCsv(actor, dataset);
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${slug}-${dataset}.csv"`,
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

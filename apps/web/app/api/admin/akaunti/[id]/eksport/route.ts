import { getDb } from '@sportkarta/db';

import { recordAccountAccess } from '@/lib/account-access';
import {
  accountExportFilename,
  accountExportResponse,
  buildAccountExport,
} from '@/lib/account-export';
import { requireRole } from '@/lib/auth-session';

/**
 * An admin downloads one member's record as JSON — the answer to an Art. 15/20
 * request from someone who can no longer sign in (lib/account-export.ts).
 *
 * A ROUTE HANDLER, like /api/admin/otcheti, because the response is a FILE and
 * needs Content-Disposition. It GATES ITSELF: /api is outside the middleware
 * matcher, so `requireRole('admin')` — which reads the role from the database —
 * is the only thing standing between a request and a person's whole record.
 * Admin-only, never `requireAdmin()`: an ambassador's authority is a set of
 * municipalities, not people.
 *
 * THE ACCESS IS RECORDED BEFORE THE DATA IS READ, under the 'export' scope
 * 0028 reserved for exactly this — "the read most likely to leave the
 * building". `recordAccountAccess` throws rather than swallowing a failure, so
 * a broken log means no file, the same fail-closed order as the account page.
 *
 * A GET, reached by a plain `<a download>` on the account page and never by a
 * `<Link>`: next/link prefetches, and a prefetch here would write an access row
 * for a download nobody asked for.
 */

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireRole('admin');
  const { id } = await params;
  // better-auth ids are short opaque strings; anything else is not an account,
  // and not worth an access row.
  if (!id || id.length > 128) return new Response(null, { status: 404 });

  // Recorded first, and never inside a try/catch — see the header.
  await recordAccountAccess(admin.id, id, 'export');

  const now = new Date();
  const data = await buildAccountExport(getDb(), id, now);
  if (!data) return new Response(null, { status: 404 });

  return accountExportResponse(data, accountExportFilename(now, id));
}

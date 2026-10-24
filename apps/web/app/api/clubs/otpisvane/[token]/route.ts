import { clubsEnabled } from '@/lib/clubs/access';
import { unsubscribe } from '@/lib/clubs/unsubscribe';

/**
 * RFC 8058 one-click unsubscribe: a mail client POSTs
 * `List-Unsubscribe=One-Click` here from the header of a club mail to an
 * unlinked client. No session, no cookie, no body in the response — the
 * token is the whole authority and it grants nothing but this. GET does
 * nothing (link scanners prefetch), and humans use /klubove/otpisvane/<token>.
 */
export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  if (!clubsEnabled()) return new Response(null, { status: 404 });
  const { token } = await params;
  const ok = await unsubscribe(token);
  return new Response(null, { status: ok ? 200 : 404, headers: { 'Cache-Control': 'no-store' } });
}

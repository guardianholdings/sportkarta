import { getDb } from '@sportkarta/db';

import { unsubscribeByToken } from '@/lib/digest';
import { siteUrl } from '@/lib/seo';

/**
 * RFC 8058 one-click unsubscribe for the weekly digest (Stage 4.4).
 *
 * The digest carries `List-Unsubscribe: <…/api/digest/unsubscribe/{token}>` and
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. That pair is what puts a
 * native "Unsubscribe" control next to the sender in Gmail and Yahoo, and when a
 * member presses it their mail provider POSTs here — no page, no session, no
 * second click. Without it the only way out the inbox offers is "Report spam",
 * and complaints count against the same sending account that delivers sign-in
 * codes.
 *
 * THE POST UNSUBSCRIBES; THE GET NEVER DOES. The rule the human confirm page
 * (/sedmitsata/otpisvane/[token]) is built on holds here too: corporate link
 * scanners fetch every URL in an inbound message, so a destructive GET would
 * cancel subscriptions nobody asked to cancel. A GET is only a person who
 * opened the header URL in a browser, and it is sent to that confirm page.
 *
 * The token IS the authorisation — random per subscription, 192 bits, and it
 * cancels exactly one (member, city) pair. An unknown token answers exactly
 * like a known one, so the endpoint is not an oracle for which tokens exist;
 * it is also what a mail provider's second POST produces.
 */

export const dynamic = 'force-dynamic';

/** The shape digest_subscriptions.unsubscribe_token's CHECK allows. */
const TOKEN_RE = /^[A-Za-z0-9_-]{22,128}$/;

interface Params {
  params: Promise<{ token: string }>;
}

function done(): Response {
  // RFC 8058 §3.2: no redirect in answer to the POST. The body is for nobody
  // in particular — the mail client shows its own confirmation.
  return new Response('OK', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function POST(_request: Request, { params }: Params): Promise<Response> {
  const { token } = await params;
  if (TOKEN_RE.test(token)) await unsubscribeByToken(getDb(), token);
  return done();
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const { token } = await params;
  // Not a 404 for a malformed token: the confirm page already renders the
  // "no longer valid" state, and one answer for every token leaks nothing.
  // The configured public origin, not the request's: behind the proxy the
  // request URL is the container's own address.
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${siteUrl()}/sedmitsata/otpisvane/${encodeURIComponent(token)}`,
      'Cache-Control': 'no-store',
    },
  });
}

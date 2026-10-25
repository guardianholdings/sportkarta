import { getDb, sql } from '@sportkarta/db';
import { createStripeClient, isStripeAccountId, stripeSettings } from '@sportkarta/lib/payments';
import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth-session';
import { clubsEnabled } from '@/lib/clubs/access';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { connectAccount, paymentProvider, verifyConnectState } from '@/lib/clubs/payments';
import { siteUrl } from '@/lib/seo';

/**
 * Stripe Connect's OAuth return (0046). Three checks before anything is
 * stored, in this order:
 *   1. the `state` is ours (HMAC from AUTH_SECRET), fresh (30 minutes), and
 *      names a club and a person;
 *   2. the person signed in NOW is that person — a stolen callback URL is
 *      useless in somebody else's browser;
 *   3. that person still holds settings.manage at that club (requireClubStaff,
 *      and connectAccount embeds the scope again in its statement).
 * Only then is the code exchanged, and only the account id is kept.
 */

export const dynamic = 'force-dynamic';

function back(_request: Request, slug: string | null, outcome: string): NextResponse {
  // The configured origin, never the request's Host: behind the proxy a
  // forged Host header must not choose where the owner is sent.
  const target = new URL(slug ? `/klub/${slug}/nastroyki` : '/klub', siteUrl());
  target.searchParams.set('plashtaniya', outcome);
  target.hash = 'plashtaniya';
  return NextResponse.redirect(target, 303);
}

export async function GET(request: Request): Promise<Response> {
  if (!clubsEnabled() || paymentProvider() !== 'stripe') {
    return new Response('Not found', { status: 404 });
  }
  const url = new URL(request.url);
  const state = verifyConnectState(url.searchParams.get('state') ?? '');
  if (!state) return back(request, null, 'connect_failed');
  const user = await getCurrentUser();
  if (!user || user.id !== state.userId) return back(request, null, 'connect_failed');
  const club = (await getDb().execute(sql`SELECT slug FROM clubs WHERE id = ${state.clubId}::uuid`))
    .rows[0];
  if (!club) return back(request, null, 'connect_failed');
  const slug = String(club.slug);
  const { actor } = await requireClubStaff(slug, 'settings.manage');

  const code = url.searchParams.get('code');
  // The owner pressed «Отказ» on Stripe's page, or Stripe refused.
  if (!code || !/^[A-Za-z0-9_]{8,255}$/.test(code)) return back(request, slug, 'connect_cancelled');
  const settings = stripeSettings(process.env);
  if (!settings) return back(request, slug, 'connect_failed');
  const client = createStripeClient({ secretKey: settings.secretKey });
  try {
    const token = await client.oauthToken(code);
    if (!isStripeAccountId(token.stripe_user_id)) return back(request, slug, 'connect_failed');
    const account = await client.retrieveAccount(token.stripe_user_id);
    const saved = await connectAccount(getDb(), actor, {
      provider: 'stripe',
      accountRef: token.stripe_user_id,
      chargesEnabled: account.charges_enabled === true,
    });
    return back(request, slug, saved ? 'connected' : 'connect_failed');
  } catch {
    return back(request, slug, 'connect_failed');
  }
}

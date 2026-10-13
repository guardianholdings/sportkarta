import { NextResponse, type NextRequest } from 'next/server';

import { clientIpFromForwardedFor } from '@/lib/rate-limit';
import { buildAuthorizeUrl, getTikTokDemoConfig } from '@/lib/tiktok/config';
import { newState, notFoundResponse, redirectToPage, setStateCookie } from '@/lib/tiktok/http';
import { tiktokLimiters } from '@/lib/tiktok/session-store';

/**
 * „Continue with TikTok“ (the /tiktok demo, decision #41): mint a single-use
 * `state`, keep it in an httpOnly cookie for ten minutes, and send the browser
 * to TikTok's v2 authorization page. The callback checks the state before it
 * touches the code. No PKCE: TikTok's token docs require a code_verifier only
 * for mobile and desktop apps, and the code exchange here runs server-side
 * with the client secret.
 */

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  const config = getTikTokDemoConfig();
  if (!config.enabled) return notFoundResponse();

  const ip = clientIpFromForwardedFor(request.headers.get('x-forwarded-for')) ?? 'local';
  if (!tiktokLimiters().start.check(ip).allowed) return redirectToPage(config, { error: 'rate' });

  const state = newState();
  const response = NextResponse.redirect(buildAuthorizeUrl(config, state), {
    status: 302,
    headers: { 'Cache-Control': 'no-store' },
  });
  setStateCookie(response, config, state);
  return response;
}

import { NextResponse, type NextRequest } from 'next/server';

import { revokeToken } from '@/lib/tiktok/api';
import { getTikTokDemoConfig } from '@/lib/tiktok/config';
import {
  clearSessionCookie,
  isSameOriginPost,
  notFoundResponse,
  redirectToPage,
  SESSION_COOKIE,
} from '@/lib/tiktok/http';
import { tiktokSessions } from '@/lib/tiktok/session-store';

/**
 * „Disconnect TikTok“: revoke the token at TikTok (best effort), forget it
 * here, clear the cookie, back to /tiktok. A form POST from our own page only.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const config = getTikTokDemoConfig();
  if (!config.enabled) return notFoundResponse();
  if (!isSameOriginPost(request, config.siteOrigin)) {
    return new NextResponse('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const session = tiktokSessions().delete(request.cookies.get(SESSION_COOKIE)?.value);
  if (session) await revokeToken(config, session.accessToken);

  const response = redirectToPage(config, { signedOut: true });
  clearSessionCookie(response, config);
  return response;
}

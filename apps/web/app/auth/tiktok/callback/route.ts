import type { NextRequest } from 'next/server';

import { exchangeCode, hasRequiredScopes, revokeToken } from '@/lib/tiktok/api';
import { getTikTokDemoConfig } from '@/lib/tiktok/config';
import {
  clearStateCookie,
  notFoundResponse,
  redirectToPage,
  setSessionCookie,
  STATE_COOKIE,
  statesMatch,
  type PageError,
} from '@/lib/tiktok/http';
import { tiktokSessions } from '@/lib/tiktok/session-store';

/**
 * TikTok sends the browser back here (the redirect URI registered for the app:
 * https://pops.bg/auth/tiktok/callback).
 *
 * The state is checked first and is single use — its cookie is cleared on
 * every outcome. The code is exchanged server-side (the client secret never
 * leaves the server), the token goes into the in-memory store, and the browser
 * gets only a random session id. No pops.bg account or session is created, and
 * member sign-in is not involved at all.
 *
 * Every failure — the user said no, TikTok erred, the state does not match,
 * the link is opened bare — lands on /tiktok with a plain message. Never a 500.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const config = getTikTokDemoConfig();
  if (!config.enabled) return notFoundResponse();

  const fail = (error: PageError) => {
    const response = redirectToPage(config, { error });
    clearStateCookie(response, config);
    return response;
  };

  const params = request.nextUrl.searchParams;
  const tiktokError = params.get('error');
  if (tiktokError) return fail(tiktokError === 'access_denied' ? 'denied' : 'tiktok');

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return fail('missing');

  const expected = request.cookies.get(STATE_COOKIE)?.value;
  if (!expected || !statesMatch(state, expected)) return fail('state');

  const grant = await exchangeCode(config, code);
  if (!grant.ok) return fail('token');
  if (!hasRequiredScopes(grant.data.scopes)) {
    await revokeToken(config, grant.data.accessToken);
    return fail('scope');
  }

  const { id, maxAgeSec } = tiktokSessions().create(
    grant.data.accessToken,
    grant.data.expiresInSec,
  );
  if (maxAgeSec <= 0) {
    tiktokSessions().delete(id);
    return fail('token');
  }

  const response = redirectToPage(config);
  clearStateCookie(response, config);
  setSessionCookie(response, config, id, maxAgeSec);
  console.info(`[tiktok] signed in: sessions=${tiktokSessions().size}`);
  return response;
}

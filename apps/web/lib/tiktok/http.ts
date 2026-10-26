import { randomBytes, timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { TIKTOK_PAGE_PATH, type EnabledTikTokConfig } from './config';

/**
 * Responses and cookies shared by the /tiktok demo's route handlers.
 *
 * Two cookies, both httpOnly and SameSite=Lax (the callback is a top-level
 * GET from tiktok.com, which Lax lets through), Secure whenever the site is on
 * https, and each scoped to the only path that reads it:
 *   pops_tiktok_state    the OAuth `state`, 10 minutes, /auth/tiktok, single use
 *   pops_tiktok_session  a random id into lib/tiktok/session-store.ts, /tiktok
 * Neither carries a token.
 */

export const STATE_COOKIE = 'pops_tiktok_state';
export const STATE_COOKIE_PATH = '/auth/tiktok';
export const STATE_MAX_AGE_SEC = 10 * 60;
export const SESSION_COOKIE = 'pops_tiktok_session';
export const SESSION_COOKIE_PATH = '/tiktok';

/** Messages the page shows for `?error=` (app/tiktok/page.tsx). */
export const PAGE_ERRORS = [
  'denied',
  'tiktok',
  'missing',
  'state',
  'token',
  'scope',
  'rate',
] as const;
export type PageError = (typeof PAGE_ERRORS)[number];

const NO_STORE = { 'Cache-Control': 'no-store' };

/** The flag is off: answer as if the route did not exist. */
export function notFoundResponse(): NextResponse {
  return new NextResponse('Not Found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE },
  });
}

export function jsonResponse(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Back to /tiktok, optionally with a message. 303: the next request is a GET. */
export function redirectToPage(
  config: EnabledTikTokConfig,
  query: { error?: PageError; signedOut?: boolean } = {},
): NextResponse {
  const url = new URL(TIKTOK_PAGE_PATH, config.siteOrigin);
  if (query.error) url.searchParams.set('error', query.error);
  if (query.signedOut) url.searchParams.set('signed_out', '1');
  return NextResponse.redirect(url, { status: 303, headers: NO_STORE });
}

export function newState(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison of the callback's state with the cookie's. */
export function statesMatch(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function setStateCookie(response: NextResponse, config: EnabledTikTokConfig, state: string) {
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax',
    path: STATE_COOKIE_PATH,
    maxAge: STATE_MAX_AGE_SEC,
  });
}

export function clearStateCookie(response: NextResponse, config: EnabledTikTokConfig) {
  response.cookies.set(STATE_COOKIE, '', {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax',
    path: STATE_COOKIE_PATH,
    maxAge: 0,
  });
}

export function setSessionCookie(
  response: NextResponse,
  config: EnabledTikTokConfig,
  id: string,
  maxAgeSec: number,
) {
  response.cookies.set(SESSION_COOKIE, id, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax',
    path: SESSION_COOKIE_PATH,
    maxAge: maxAgeSec,
  });
}

export function clearSessionCookie(response: NextResponse, config: EnabledTikTokConfig) {
  response.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax',
    path: SESSION_COOKIE_PATH,
    maxAge: 0,
  });
}

/**
 * A POST must come from our own pages: the browser's Origin header names the
 * site (or, behind a proxy, the Host the request was sent to). No Origin, no
 * POST — every browser sends it on a form or fetch POST.
 */
export function isSameOriginPost(request: Request, siteOrigin: string): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  let from: URL;
  try {
    from = new URL(origin);
  } catch {
    return false;
  }
  if (from.origin === new URL(siteOrigin).origin) return true;
  const host = request.headers.get('host');
  return host !== null && from.host === host;
}

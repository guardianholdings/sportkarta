import { getSessionCookie } from 'better-auth/cookies';
import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';

import { routing } from './i18n/routing';
import { isProtectedPath, REQUEST_PATH_HEADER } from './lib/sign-in-destination';

const intlMiddleware = createMiddleware(routing);

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // First gate only, and an optimistic one: it checks that a session cookie
  // exists, not that it is valid. Role checks and real session verification
  // happen in the layout and in every server action (lib/auth-session.ts) —
  // this exists to avoid rendering an admin shell for signed-out visitors.
  // Which routes, and why /pasport is anchored: lib/sign-in-destination.ts.
  if (isProtectedPath(pathname) && !getSessionCookie(request)) {
    const signIn = request.nextUrl.clone();
    const locale = pathname.startsWith('/en/') || pathname === '/en' ? '/en' : '';
    signIn.pathname = `${locale}/vhod`;
    // Carry the requested page so a deep link (say /admin/verify) resumes after
    // signing in. Only the path travels — query strings can carry state that
    // does not survive a round trip, and the value is re-validated in the
    // sign-in action (lib/sign-in-destination.ts) before any redirect happens.
    signIn.search = `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(signIn);
  }

  // Which page this request is for, so requireUser() can send a signed-out
  // visitor back here after the code step (lib/sign-in-destination.ts). Set on
  // EVERY request, overwriting anything the client sent; next-intl copies the
  // request headers onto the request the page renders with.
  request.headers.set(REQUEST_PATH_HEADER, pathname);
  return intlMiddleware(request);
}

export const config = {
  // Skip API routes, Next internals and any path with a file extension.
  matcher: '/((?!api|_next|_vercel|.*\\..*).*)',
};

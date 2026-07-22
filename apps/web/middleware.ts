import { getSessionCookie } from 'better-auth/cookies';
import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';

import { routing } from './i18n/routing';

const intlMiddleware = createMiddleware(routing);

// Routes that require a signed-in account: /admin and /profil, with or without
// a locale prefix. /vhod (sign-in) is public by definition.
const PROTECTED_PATH = /^\/(?:(?:bg|en)\/)?(?:admin|profil)(?:\/|$)/;

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // First gate only, and an optimistic one: it checks that a session cookie
  // exists, not that it is valid. Role checks and real session verification
  // happen in the layout and in every server action (lib/auth-session.ts) —
  // this exists to avoid rendering an admin shell for signed-out visitors.
  if (PROTECTED_PATH.test(pathname) && !getSessionCookie(request)) {
    const signIn = request.nextUrl.clone();
    const locale = pathname.startsWith('/en/') || pathname === '/en' ? '/en' : '';
    signIn.pathname = `${locale}/vhod`;
    // Carry the requested page so a deep link (say /admin/verify) resumes after
    // signing in. Only the path travels — query strings can carry state that
    // does not survive a round trip, and the value is re-validated in the
    // sign-in action (lib/safe-redirect.ts) before any redirect happens.
    signIn.search = `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(signIn);
  }

  return intlMiddleware(request);
}

export const config = {
  // Skip API routes, Next internals and any path with a file extension.
  matcher: '/((?!api|_next|_vercel|.*\\..*).*)',
};

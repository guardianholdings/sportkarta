import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';

import { ADMIN_COOKIE, verifyAdminToken } from './lib/admin-auth';
import { routing } from './i18n/routing';

const intlMiddleware = createMiddleware(routing);

// /admin and /{locale}/admin, except the login page itself.
const ADMIN_PATH = /^\/(?:(?:bg|en)\/)?admin(?:\/|$)/;
const LOGIN_PATH = /^\/(?:(?:bg|en)\/)?admin\/login\/?$/;

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // First gate only — the admin layout and every server action re-verify.
  if (ADMIN_PATH.test(pathname) && !LOGIN_PATH.test(pathname)) {
    const identity = verifyAdminToken(request.cookies.get(ADMIN_COOKIE)?.value);
    if (!identity) {
      const login = request.nextUrl.clone();
      const locale = pathname.startsWith('/en/') || pathname === '/en' ? '/en' : '';
      login.pathname = `${locale}/admin/login`;
      login.search = '';
      return NextResponse.redirect(login);
    }
  }

  return intlMiddleware(request);
}

export const config = {
  // Skip API routes, Next internals and any path with a file extension.
  matcher: '/((?!api|_next|_vercel|.*\\..*).*)',
};

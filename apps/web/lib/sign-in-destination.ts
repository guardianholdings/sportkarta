import { routing } from '@/i18n/routing';

import { isSafeRedirect } from './safe-redirect';

/**
 * Where sign-in sends a member, and in which language — and which pages send
 * them there.
 *
 * `next` travels as an in-site path. It may or may not carry a locale prefix —
 * middleware sends `/en/dobavi`, a page link sends `/obekt/<slug>` — and the
 * prefix is deliberately IGNORED: the member lands in the language they signed
 * in with, which is the language of the /vhod page they were on. Callers render
 * the unprefixed result through next-intl (`redirect({ href, locale })` or
 * `getPathname`), which adds the right prefix for that locale. Before this, every
 * destination and fallback went through next/navigation's `redirect`, whose
 * unprefixed paths are Bulgarian, so English members were switched to Bulgarian
 * on every sign-in and sign-out.
 *
 * Pure (no next-intl runtime), so middleware can import it and
 * tests/sign-in-destination.test.ts can exercise the rules directly.
 */

/** Public sign-in route (Bulgarian-first slugs, like the rest of the site). */
export const SIGN_IN_PATH = '/vhod';
export const PROFILE_PATH = '/profil';

/**
 * Request header middleware sets to the page's pathname, so server code that
 * decides "you must sign in first" (requireUser) can send the member back to
 * the page they asked for. Next exposes no pathname to server components.
 * Middleware overwrites any client-supplied value, and the value is validated
 * like any other `next` before it is used.
 */
export const REQUEST_PATH_HEADER = 'x-sportkarta-path';

/**
 * Routes middleware sends straight to sign-in when there is no session cookie:
 * /admin, /profil, /dobavi (adding a facility) and /trenirovki (a member's own
 * training log), with or without a locale prefix. /vhod (sign-in) is public by
 * definition, and so is every facility page — the verify and condition forms on
 * them gate themselves. Pages gated only by requireUser() (API keys, an
 * organiser's QR) still land back where they started, via REQUEST_PATH_HEADER.
 *
 * `/pasport` is the member's OWN passport and is protected — but only exactly
 * that path. `/pasport/<handle>` is somebody's opt-in public passport and must
 * stay reachable signed out, which is why this alternation is anchored with
 * `$` instead of joining the group above: `(?:admin|profil|dobavi|pasport)`
 * would have matched the public URL too and made the feature dead on arrival
 * for exactly the people it is shared with.
 */
const PROTECTED_PATH =
  /^\/(?:(?:bg|en)\/)?(?:(?:admin|profil|dobavi|trenirovki)(?:\/|$)|pasport\/?$)/;

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PATH.test(pathname);
}

/** `/en/obekt/x` → `/obekt/x`, `/en` → `/`, `/english` unchanged. */
export function withoutLocalePrefix(path: string): string {
  for (const locale of routing.locales) {
    const prefix = `/${locale}`;
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest === '') return '/';
    if (rest.startsWith('/')) return rest;
    if (rest.startsWith('?') || rest.startsWith('#')) return `/${rest}`;
  }
  return path;
}

function isSignInPath(path: string): boolean {
  if (!path.startsWith(SIGN_IN_PATH)) return false;
  const rest = path.slice(SIGN_IN_PATH.length);
  return rest === '' || /^[/?#]/.test(rest);
}

/**
 * The unprefixed in-site path `next` points at, or null when it is missing,
 * unsafe, or the sign-in page itself (a signed-in visitor is bounced from /vhod
 * to its `next`, so that would loop). Validated before AND after the prefix is
 * stripped: `/en//evil.example` is a harmless path until its prefix comes off,
 * and then it is a protocol-relative URL onto somebody else's site.
 */
export function safeDestination(next: unknown): string | null {
  if (typeof next !== 'string' || !isSafeRedirect(next)) return null;
  const path = withoutLocalePrefix(next);
  return isSafeRedirect(path) && !isSignInPath(path) ? path : null;
}

/** Where a successful sign-in lands: the requested page, else the profile. */
export function signInDestination(next: unknown): string {
  return safeDestination(next) ?? PROFILE_PATH;
}

/**
 * The i18n `Link`/`redirect` href of the sign-in page, carrying the page to
 * return to. Unsafe or circular destinations are dropped, not passed along.
 */
export function signInHref(next?: string | null): {
  pathname: typeof SIGN_IN_PATH;
  query?: { next: string };
} {
  const destination = safeDestination(next);
  return destination
    ? { pathname: SIGN_IN_PATH, query: { next: destination } }
    : { pathname: SIGN_IN_PATH };
}

/** Why the visitor was sent to sign in — one line on /vhod says it. */
export type SignInReason = 'add' | 'passport' | 'training' | 'contribute' | 'session' | 'checkin';

/** An exact path, or a prefix ending in «/» for the pages that carry an id. */
const REASONS: readonly [path: string, reason: SignInReason][] = [
  ['/dobavi', 'add'],
  ['/pasport', 'passport'],
  ['/trenirovki', 'training'],
  ['/obekt/', 'contribute'],
  ['/sesiya/', 'session'],
  ['/otmetka/', 'checkin'],
];

/**
 * The reason behind a `next`, or null for "no particular reason" (the profile,
 * anything else). A tap on «+» used to land on a bare «Вход в POPS» that never
 * said adding a facility needs an account (UX audit 2026-10-10). Read from the
 * same sanitised destination the redirect uses, so an unsafe `next` says
 * nothing.
 */
export function signInReason(next: unknown): SignInReason | null {
  const destination = safeDestination(next);
  if (!destination) return null;
  const path = destination.split(/[?#]/)[0] ?? '';
  for (const [match, reason] of REASONS) {
    if (match.endsWith('/') ? path.startsWith(match) : path === match) return reason;
  }
  return null;
}

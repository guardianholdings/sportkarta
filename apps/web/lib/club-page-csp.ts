import { TRACKING_SCRIPT_ORIGINS } from '@sportkarta/lib/clubs';

/**
 * The script policy of a club's PUBLIC pages (wave H2) — the pages where a
 * paid club's own GA4 or Meta Pixel may load, after the visitor accepts.
 *
 * Defence in depth around a feature that is already ids-only (0058): it lists
 * the only places a script may come from — this site, the two vendors, and
 * the site's own Umami — so nothing else can load a script there, whatever a
 * future bug lets into the page. Only `script-src` (with `worker-src`, which
 * would otherwise fall back to it) is restricted: connections and images stay
 * open, because the vendors' beacons, Umami's and GlitchTip's all need them.
 * Inline scripts stay allowed — Next's own hydration scripts are inline and
 * this policy carries no nonce.
 *
 * What it does and does not cover:
 *  - A policy belongs to a DOCUMENT, so a club page reached by in-app
 *    navigation runs under the policy of the page the visitor first loaded.
 *    The vendors never start in such a document: the runtime reloads first
 *    (lib/club-tracking-runtime.ts), so they always run under this policy.
 *  - The reverse also holds: a visitor who first loaded a club page keeps
 *    this `script-src` while navigating in-app elsewhere. Harmless today — no
 *    other page loads a third-party script — but a future one (a payment or
 *    captcha widget) would have to be listed here or reached by a full load.
 *  - It cannot tell gtag.js from a tag manager container (same origin);
 *    "ids only" is held by 0058's CHECKs and the runtime, not by this.
 *  - It has no report-uri: a refused script is visible only in the console.
 *
 * `frame-ancestors 'none'` is LOAD-BEARING: this header replaces
 * next.config.ts's CSP on these routes (Next keeps the middleware's), so the
 * framing rule would otherwise be lost here.
 */

/** A club's public page: the club page, an event, a class date, the inquiry form. */
const CLUB_PUBLIC_PAGE =
  /^(?:\/en)?\/klub\/[a-z0-9-]{3,60}(?:\/zapitvane|\/(?:sabitie|trenirovka)\/[^/]+)?\/?$/;

export function isClubPublicPage(pathname: string): boolean {
  return CLUB_PUBLIC_PAGE.test(pathname);
}

function originOf(src: string | undefined): string | null {
  if (!src) return null;
  try {
    const url = new URL(src);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function clubPageCsp(options: { dev: boolean; analyticsSrc?: string }): string {
  const scripts = new Set<string>(["'self'", "'unsafe-inline'", ...TRACKING_SCRIPT_ORIGINS]);
  // The dev server's hot reload evaluates code; a production build never does.
  if (options.dev) scripts.add("'unsafe-eval'");
  const analytics = originOf(options.analyticsSrc);
  if (analytics) scripts.add(analytics);
  return [
    `script-src ${[...scripts].join(' ')}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

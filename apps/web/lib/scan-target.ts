/**
 * What the in-app QR scanner (/skenirai) may open: a POPS check-in link and
 * nothing else (UX audit N3). A QR is a string anybody can print, so a decoded
 * code is a URL to be checked, never a place to go.
 *
 * The two check-in pages print `${siteUrl()}/otmetka/<token>` (a public
 * тренировка, the organiser's screen) and `${siteUrl()}/klubove/otmetka/<token>`
 * (a club's tablet). A code is accepted when its origin is one of `origins` —
 * the page's own and the configured site's, which differ in development — and
 * its path is exactly one of those two, with or without a locale prefix. What
 * comes back is the PATH without the locale, which the scanner opens on its own
 * origin and in the member's own language: the scanner never navigates to an
 * address the code chose.
 *
 * The token alphabet is base64url plus the `~` separator
 * (lib/src/checkin-token); anything else is not a token.
 */
const CHECKIN_PATH = /^(?:\/(?:bg|en))?(\/(?:klubove\/)?otmetka\/[A-Za-z0-9_~-]{8,256})\/?$/;

export function scanTarget(decoded: string, origins: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(decoded.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (!origins.includes(url.origin)) return null;
  return CHECKIN_PATH.exec(url.pathname)?.[1] ?? null;
}

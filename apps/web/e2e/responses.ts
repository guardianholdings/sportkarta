/**
 * How a page says "no" once it has already said 200.
 *
 * The root loading boundary (app/[locale]/loading.tsx) makes Next stream a
 * 200 shell before the page resolves, so a notFound() or a redirect() thrown
 * afterwards can no longer change the status line. Four e2e assertions went
 * red over exactly that — a hidden admin screen "reached: 200", the organiser's
 * QR screen "200, expected 404" — while the pages were denying correctly.
 *
 * What Next does instead is write a marker into the streamed HTML
 * (next/dist/server/app-render/make-get-server-inserted-html.js):
 *
 *   notFound()  → <meta name="robots" content="noindex"/>
 *   redirect()  → <meta id="__next-page-redirect" http-equiv="refresh" content="1;url=…"/>
 *
 * The same noindex tag also accompanies a real 404 status. These are the
 * framework's own signals, so they hold whatever the not-found page says and
 * in whichever language: asserting Next's default English "This page could not
 * be found" would break the day a localized not-found page lands. A page's own
 * metadata never collides with them — every page here that opts out of
 * indexing says "noindex, nofollow" or "noindex, follow", never bare
 * "noindex".
 */

const NOT_FOUND_MARKER = /<meta name="robots" content="noindex"\s*\/?>/;
const PAGE_REDIRECT = /<meta id="__next-page-redirect"[^>]*content="\d+;url=([^"]*)"/;

/** Did this response render the not-found UI, whatever its status line says? */
export function rendersNotFound(status: number, html: string): boolean {
  return status === 404 || NOT_FOUND_MARKER.test(html);
}

/**
 * Where a page sent its visitor with redirect() after streaming had started,
 * as a path without a locale prefix — or null when it did not redirect.
 */
export function softRedirectTarget(html: string): string | null {
  const match = PAGE_REDIRECT.exec(html);
  if (!match) return null;
  const url = new URL((match[1] ?? '').replaceAll('&amp;', '&'), 'http://localhost');
  return url.pathname.replace(/^\/(bg|en)(?=\/|$)/, '') || '/';
}

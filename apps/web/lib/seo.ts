import type { Metadata } from 'next';

// Absolute-URL base for canonicals + hreflang. Trailing slash trimmed so we can
// concatenate paths cleanly.
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

export function siteUrl(): string {
  return SITE_URL;
}

/**
 * The site's address as PRINTED on an image — the story call-to-action — where
 * a scheme would be noise: "pops.bg", not "https://pops.bg".
 *
 * Derived from the same configured origin rather than written into the copy.
 * The copy used to say "pops.bg" outright while that name did not resolve, so
 * every story shared from a phone pointed its recipient at a dead domain; the
 * printed address now always matches the one the site is actually served from.
 *
 * Never throws: a malformed env value prints as written (minus any scheme)
 * rather than turning every story image into a 500.
 */
export function siteHost(): string {
  try {
    return new URL(SITE_URL).host;
  } catch {
    return SITE_URL.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  }
}

/**
 * Canonical + hreflang alternates for a locale-agnostic path (leading slash, no
 * locale prefix). bg is served unprefixed (default locale) at `path`; en at
 * `/en{path}`. Each locale self-canonicalizes; hreflang lists both plus
 * x-default = bg (Bulgarian-first). Pass the current request locale.
 */
export function buildAlternates(path: string, locale: string): Metadata['alternates'] {
  const rel = path === '/' ? '' : path;
  const bg = `${SITE_URL}${rel || '/'}`;
  const en = `${SITE_URL}/en${rel}`;
  return {
    canonical: locale === 'en' ? en : bg,
    languages: { bg, en, 'x-default': bg },
  };
}

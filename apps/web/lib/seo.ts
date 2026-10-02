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

/** Open Graph locale tags (language_TERRITORY), per app locale. */
const OG_LOCALE: Record<string, string> = { bg: 'bg_BG', en: 'en_GB' };

/** The site-wide share card, rendered by app/og/[locale]/site/card.png. */
export function siteCardPath(locale: string): string {
  return `/og/${locale === 'en' ? 'en' : 'bg'}/site/card.png`;
}

/**
 * Default Open Graph + Twitter tags every page inherits from the [locale]
 * layout. Only the facility, session, campaign and passport pages declared
 * their own, so the links people actually paste at launch — the home page, a
 * city page, /statistika — previewed on Facebook, Viber and Messenger with no
 * card at all.
 *
 * Deliberately WITHOUT title or description: Next fills a missing og:title /
 * og:description from the page's own resolved <title> and description, so
 * every page previews under its own name while sharing the brand image. A
 * page that sets `openGraph` itself replaces this object whole (Next merges
 * metadata one top-level key at a time), which is exactly right for the
 * entity pages that render their own card.
 */
export function siteSocialMetadata(
  locale: string,
  labels: { siteName: string; imageAlt: string },
): Pick<Metadata, 'openGraph' | 'twitter'> {
  const own = OG_LOCALE[locale] ?? 'bg_BG';
  return {
    openGraph: {
      type: 'website',
      siteName: labels.siteName,
      locale: own,
      alternateLocale: Object.values(OG_LOCALE).filter((l) => l !== own),
      images: [{ url: siteCardPath(locale), width: 1200, height: 630, alt: labels.imageAlt }],
    },
    twitter: { card: 'summary_large_image' },
  };
}

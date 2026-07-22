import type { Metadata } from 'next';

// Absolute-URL base for canonicals + hreflang. Trailing slash trimmed so we can
// concatenate paths cleanly.
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

export function siteUrl(): string {
  return SITE_URL;
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

import { getTranslations } from 'next-intl/server';

import { cachedOgCard } from '@/lib/og/card';
import { OG_PALETTE } from '@/lib/og/palette';

/**
 * The site-wide link-preview card — the image every page without a card of
 * its own inherits from the [locale] layout (lib/seo.ts siteSocialMetadata):
 * the home page, the city and sport pages, /statistika, /sesii.
 *
 * It follows the three path rules the sibling [kind]/[slug] route documents:
 * not under /api (robots.txt), a dotted final segment (so the i18n middleware
 * leaves it alone) and the locale as a segment (because that same dot means
 * next-intl never resolves a request locale here).
 *
 * Brand only — no place, no person, no map data — so it is public, carries no
 * attribution line, and keeps ImageResponse's long immutable cache.
 */

export const runtime = 'nodejs';

type Params = Promise<{ locale: string }>;

export async function GET(_request: Request, { params }: { params: Params }) {
  const { locale } = await params;
  const lang = locale === 'en' ? 'en' : 'bg';
  const [tOg, tMeta] = await Promise.all([
    getTranslations({ locale: lang, namespace: 'Og' }),
    getTranslations({ locale: lang, namespace: 'Metadata' }),
  ]);
  return cachedOgCard({
    title: tOg('site.title'),
    subtitle: tMeta('description'),
    wordmark: tOg('wordmark'),
    accent: OG_PALETTE.accent,
  });
}

import { getTranslations } from 'next-intl/server';

import { cachedOgCard } from '@/lib/og/card';
import { OG_PALETTE } from '@/lib/og/palette';

/**
 * The clubs page's link-preview card — the site card's sibling with the
 * clubs promise on it, so a link to /za-klubove pasted into a chat previews
 * as the offer and not as the map. Same three path rules as the site card
 * (not under /api, a dotted final segment, the locale as a segment); brand
 * only, so it is public and keeps the long immutable cache.
 */

export const runtime = 'nodejs';

type Params = Promise<{ locale: string }>;

export async function GET(_request: Request, { params }: { params: Params }) {
  const { locale } = await params;
  const lang = locale === 'en' ? 'en' : 'bg';
  const tOg = await getTranslations({ locale: lang, namespace: 'Og' });
  return cachedOgCard({
    title: tOg('clubs.title'),
    subtitle: tOg('clubs.subtitle'),
    wordmark: tOg('wordmark'),
    accent: OG_PALETTE.brand,
  });
}

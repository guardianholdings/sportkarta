import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

/**
 * Catch-all for a localized path that matches no route (/nyama-takava,
 * /en/no-such-page). Without it Next answers from the ROOT not-found, which
 * sits outside [locale]/layout.tsx: no <html lang>, no translations, no app
 * shell — the bare English page the pre-launch audit found. Matching the path
 * here instead makes it throw inside the locale layout, so [locale]/not-found
 * renders it, in the visitor's language, with the navigation around it.
 *
 * Every real route is more specific than this one and wins; the admin area
 * keeps its own catch-all so a missing /admin/* answers like a hidden one.
 */

type PageParams = Promise<{ locale: string }>;

/**
 * The same title not-found.tsx declares. A notFound() thrown during the
 * server render is painted by the client from this route's own payload, and
 * without metadata here the tab switched to the site's default title as soon
 * as it did.
 */
export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'NotFound' });
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

export default function LocaleCatchAll(): never {
  notFound();
}

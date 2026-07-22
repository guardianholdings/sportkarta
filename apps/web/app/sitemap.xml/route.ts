import { renderSitemapIndex, XML_HEADERS } from '@/lib/sitemap-xml';

// Sitemap INDEX referencing the segmented child sitemaps. Cached + revalidated
// hourly (the children query the DB) — fresh enough for crawlers without a scan
// per request. Dotted path bypasses the i18n middleware, so it is locale-agnostic.
export const revalidate = 3600;

const SEGMENTS = ['facilities.xml', 'places.xml', 'static.xml'];

export function GET() {
  return new Response(renderSitemapIndex(SEGMENTS), { headers: XML_HEADERS });
}

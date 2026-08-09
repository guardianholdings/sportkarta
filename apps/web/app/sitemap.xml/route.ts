import { renderSitemapIndex, XML_HEADERS } from '@/lib/sitemap-xml';

// Sitemap INDEX referencing the segmented child sitemaps. Dotted path bypasses
// the i18n middleware, so it is locale-agnostic.
//
// force-dynamic rather than a revalidate window: the index is three absolute
// URLs built from NEXT_PUBLIC_SITE_URL, which is unset in the CI image build,
// so prerendering it baked localhost:3000 into production and pointed crawlers
// at the visitor's own machine. It is three lines of XML with no database
// access — there is nothing here worth caching, and the children keep their own
// revalidation.
export const dynamic = 'force-dynamic';

const SEGMENTS = ['facilities.xml', 'places.xml', 'static.xml'];

export function GET() {
  return new Response(renderSitemapIndex(SEGMENTS), { headers: XML_HEADERS });
}

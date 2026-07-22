import { sitemapCities, sitemapCitySports, sitemapFacilities } from '@/lib/places';
import { renderUrlset, XML_HEADERS, type UrlEntry } from '@/lib/sitemap-xml';

// Segmented child sitemaps (auto-updating from the DB):
//   /sitemaps/facilities.xml — every public facility page
//   /sitemaps/places.xml     — city + city×sport pages (≥3 guard)
//   /sitemaps/static.xml      — the handful of static pages
// Cached + revalidated hourly so crawlers don't trigger a full-table scan per
// request (facilities.xml ≈ 6.6k rows).
export const revalidate = 3600;

async function entriesFor(name: string): Promise<UrlEntry[] | null> {
  switch (name) {
    case 'facilities.xml':
      return sitemapFacilities();
    case 'places.xml': {
      const [cities, sports] = await Promise.all([sitemapCities(), sitemapCitySports()]);
      return [...cities, ...sports];
    }
    case 'static.xml': {
      const now = new Date().toISOString();
      return [
        { path: '/', lastmod: now },
        { path: '/privacy', lastmod: now },
      ];
    }
    default:
      return null;
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const entries = await entriesFor(name);
  if (!entries) return new Response('Not found', { status: 404 });
  return new Response(renderUrlset(entries), { headers: XML_HEADERS });
}

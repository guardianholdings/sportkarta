import {
  sitemapCities,
  sitemapCitySports,
  sitemapFacilities,
  sitemapMunicipalities,
} from '@/lib/places';
import { clubsEnabled } from '@/lib/clubs/access';
import { publicClubDirectory } from '@/lib/clubs/public';
import { STATIC_SITEMAP_PATHS } from '@/lib/sitemap-static';
import { renderUrlset, XML_HEADERS, type UrlEntry } from '@/lib/sitemap-xml';

// Segmented child sitemaps (auto-updating from the DB):
//   /sitemaps/facilities.xml — every public facility page
//   /sitemaps/places.xml     — city + city×sport pages (≥3 guard)
//   /sitemaps/static.xml      — the indexable static pages (lib/sitemap-static.ts)
//   /sitemaps/clubs.xml       — /klubove and the renderable club pages (Stage 9, flag-gated)
// Cached + revalidated hourly so crawlers don't trigger a full-table scan per
// request (facilities.xml ≈ 6.6k rows, 2.75 MB).
//
// The empty generateStaticParams is load-bearing: on a dynamic segment,
// `revalidate` without it is silently ignored and every request regenerates
// the file. Empty means nothing is built ahead (there is no database during the
// image build); each name is generated on first request and then served from
// the cache.
export const revalidate = 3600;

export function generateStaticParams(): { name: string }[] {
  return [];
}

async function entriesFor(name: string): Promise<UrlEntry[] | null> {
  switch (name) {
    case 'facilities.xml':
      return sitemapFacilities();
    case 'places.xml': {
      const [cities, sports, municipalities] = await Promise.all([
        sitemapCities(),
        sitemapCitySports(),
        sitemapMunicipalities(),
      ]);
      return [...cities, ...sports, ...municipalities];
    }
    case 'clubs.xml': {
      // Stage 9: the directory and every RENDERABLE club page — the same
      // predicate that 404s a hidden club, so a sitemap never lists one.
      if (!clubsEnabled()) return null;
      const clubs = await publicClubDirectory('bg');
      return [
        { path: '/klubove' },
        { path: '/za-klubove' },
        ...clubs.map((club) => ({ path: `/klub/${club.slug}` })),
      ];
    }
    case 'static.xml':
      // No lastmod. These entries used to be stamped with the moment the file
      // was generated, i.e. "changed today" on every hourly rebuild for a
      // privacy policy last edited months ago. A crawler that catches a date
      // lying stops trusting dates from the whole host — including the true
      // ones on the 6,000 facility entries, which is where they matter.
      return STATIC_SITEMAP_PATHS.map((path) => ({ path }));
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

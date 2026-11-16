import { OPEN_DATA_API_VERSION } from '@sportkarta/lib/opendata';
import type { MetadataRoute } from 'next';

import { siteUrl } from '@/lib/seo';

// Rendered PER REQUEST, not at build. The image is built in CI, where
// NEXT_PUBLIC_SITE_URL is unset and siteUrl() falls back to localhost:3000; a
// prerendered robots.txt therefore shipped "Sitemap: http://localhost:3000/…"
// to production and pointed every crawler at the client's own machine —
// silently disabling the site's only URL-discovery channel. The same build
// artifact has to work on an IP today and a domain tomorrow, so the URL can
// only be resolved at request time.
export const dynamic = 'force-dynamic';

// Allow crawling of public pages; keep the admin panel and API out of the index.
//
// The open-data API is the one exception under /api/, and it is spelled out
// rather than implied: it is the published, documented, licensed copy of the
// register (/danni), and a blanket `Disallow: /api/` told every well-behaved
// agent — the assistants that fetch on a person's behalf honour robots.txt —
// that the data we publish for reuse may not be read. The longer rule wins, so
// `Allow: /api/opendata/` opens exactly that prefix; its own rate limit
// (lib/opendata/limits.ts) is what bounds a crawler, as it bounds anyone.
//
// The nightly dumps under it stay closed, by a rule longer still: they are the
// whole register in one file, deliberately NOT rate-limited (a person
// downloads one once), and the edge does not cache them — a crawler
// re-fetching megabytes on every visit would land on the one server each time.
// The paged API holds the same rows and has a limit.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/api/opendata/'],
      disallow: ['/admin', '/en/admin', '/api/', `/api/opendata/${OPEN_DATA_API_VERSION}/dumps`],
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}

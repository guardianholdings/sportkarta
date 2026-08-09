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
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/admin', '/en/admin', '/api/'],
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}

import type { MetadataRoute } from 'next';

import { siteUrl } from '@/lib/seo';

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

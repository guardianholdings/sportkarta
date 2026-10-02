/**
 * The indexable pages that are not generated from data — everything
 * /sitemaps/static.xml lists. The facility, city, sport and municipality pages
 * come from the database in their own child sitemaps.
 *
 * The list used to stop at four pages, so /statistika, /danni and /sesii —
 * the pages institutions and journalists are sent to — were only discoverable
 * by crawling. An entry belongs here only if its page is public, has a
 * canonical and is not `noindex`; tests/seo-sitemap.test.ts holds every entry
 * to that against the page source. /design-system is deliberately absent: it
 * is an internal catalogue that 404s in production.
 */
export const STATIC_SITEMAP_PATHS = [
  '/',
  '/sesii',
  '/sedmitsata',
  '/statistika',
  '/danni',
  '/danni/litsenz',
  '/partnyori',
  '/podkrepi',
  '/privacy',
] as const;

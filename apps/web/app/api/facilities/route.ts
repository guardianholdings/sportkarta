import { parsePublicFilters } from '@/lib/filters';
import { facilitiesGeoJSON } from '@/lib/public-data';

// GeoJSON feed for the public map source (client-side clustered). Filters are
// allowlisted in parsePublicFilters, so raw query params never reach SQL.
// Not localized by middleware (it skips /api), so the one localised property —
// `place`, whose municipality name has a bg and an en form — takes the locale
// as an explicit, allowlisted param. It is part of the URL, so the public cache
// keys on it. Safe to cache — it is public, filter-keyed, read-only data.

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const filters = parsePublicFilters(sp);
  const locale = sp.locale === 'en' ? 'en' : 'bg';
  const collection = await facilitiesGeoJSON(filters, locale);
  return Response.json(collection, {
    headers: {
      'Content-Type': 'application/geo+json; charset=utf-8',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
    },
  });
}

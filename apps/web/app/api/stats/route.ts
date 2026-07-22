import { getStatsSnapshot } from '@/lib/stats-data';

// Cached public statistics JSON, read from the materialized views (refreshed
// every 15 min via pg-boss). force-dynamic keeps it off the build's static
// prerender (no DB during the Docker build); the Cache-Control header below
// still lets Caddy/CDN cache responses. Numbers reconcile with direct queries.
export const dynamic = 'force-dynamic';

export async function GET() {
  const snapshot = await getStatsSnapshot();
  return Response.json(snapshot, {
    headers: { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600' },
  });
}

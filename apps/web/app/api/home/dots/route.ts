import { dotLayer, dotSport } from '@/lib/home/dots';
import { topPlaces } from '@/lib/home/places';

// The front page's sport chips (components/home/hero-map.tsx): one sport's free
// places as counts per dot-grid cell and per municipality, plus the «most
// places» line. Aggregates only, over the public map's own predicate
// (lib/home/dots.ts). The sport and the locale are allowlisted, so a raw query
// value never reaches SQL, and each answer is memoised per process — the key
// space is the canonical sports times two locales. Not localised by middleware
// (it skips /api), hence the explicit `locale`, as on /api/facilities.

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const sport = dotSport(params.get('sport'));
  const locale = params.get('locale') === 'en' ? 'en' : 'bg';
  try {
    const layer = await dotLayer(sport);
    const top = await topPlaces(layer, locale);
    return Response.json(
      {
        cells: layer.cells.flatMap((cell) => [cell.i, cell.j, cell.n]),
        municipalities: layer.municipalities.flat(),
        top,
      },
      { headers: { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600' } },
    );
  } catch (error: unknown) {
    // The message, never the error object (a pg error can embed the URL).
    console.error('[home] dots failed:', error instanceof Error ? error.message : 'unknown');
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }
}

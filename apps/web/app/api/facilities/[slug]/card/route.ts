import { facilityCard } from '@/lib/facility-card';
import { CARD_CACHE_CONTROL } from '@/lib/map/card';

// One facility's facts for the map card (lib/map/card.ts). Public, read-only,
// and keyed by nothing but the slug: the slug is shape-checked before it
// reaches SQL (getFacilityBySlug), and what comes back is what the facility
// page already publishes. A facility that is unknown or not public is the same
// 404 — the card must not confirm that a hidden place exists — and that answer
// is never cached, so a place published a moment later is found.

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const card = await facilityCard(slug);
  if (!card) {
    return Response.json(
      { error: 'not_found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return Response.json(card, { headers: { 'Cache-Control': CARD_CACHE_CONTROL } });
}

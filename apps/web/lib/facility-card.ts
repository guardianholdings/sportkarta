import {
  CARD_PHOTO_LIMIT,
  CARD_SESSION_LIMIT,
  type FacilityCardData,
  type FacilityCardSession,
} from '@/lib/map/card';
import { getFacilityBySlug, type FacilityDetail } from '@/lib/public-data';
import { facilitySessions } from '@/lib/sessions/occurrence';

/**
 * The map card's facts for one facility (lib/map/card.ts says why they are
 * asked for one at a time). Server-only.
 *
 * NOTHING HERE DECIDES WHO MAY SEE WHAT. The facility comes from
 * `getFacilityBySlug`, which is the facility page's own query: the public
 * visibility predicate, approved photos only, and the «last checked» rule. A
 * card can therefore never show a place, a photo or a date the page would not —
 * a second copy of any of those rules is how the two would come to disagree.
 * The игри are the page's too (`facilitySessions`): public series, not
 * cancelled, still to start, and they name nobody.
 */

/**
 * An instant as ISO 8601, or null when it cannot be read as one.
 *
 * The facility query hands «last checked» over as Postgres prints it —
 * «2026-10-31 11:20:29.504277+00» — which this server's engine parses and a
 * visitor's browser may not: a space where the T belongs and a two-digit
 * offset are outside what `Date` is required to accept, and a date the card
 * cannot parse is a render that throws. The page formats that string on the
 * server and never noticed; the card is the first to parse it on a phone.
 */
export function isoInstant(value: string | null): string | null {
  if (!value) return null;
  const strict = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  for (const candidate of [strict, value]) {
    const time = new Date(candidate).getTime();
    if (!Number.isNaN(time)) return new Date(time).toISOString();
  }
  return null;
}

/** The page's record, cut down to what the card prints. No row id leaves. */
export function toFacilityCard(
  facility: FacilityDetail,
  sessions: FacilityCardSession[],
): FacilityCardData {
  return {
    slug: facility.slug,
    access: facility.access,
    status: facility.status,
    surface: facility.surface,
    lighting: facility.lighting,
    // The column is NOT NULL with a false default: `false` nobody asserted is
    // «unknown» on the page, and must not become «не» here.
    covered: facility.coveredKnown ? facility.covered : null,
    condition: facility.condition,
    lastVerifiedAt: isoInstant(facility.lastVerifiedAt),
    source: facility.source,
    photoIds: facility.photoIds.slice(0, CARD_PHOTO_LIMIT),
    sessions: sessions.slice(0, CARD_SESSION_LIMIT),
  };
}

/** The card for a public facility; null when unknown or not public. */
export async function facilityCard(slug: string): Promise<FacilityCardData | null> {
  const facility = await getFacilityBySlug(slug);
  if (!facility) return null;
  let sessions: FacilityCardSession[] = [];
  try {
    sessions = await facilitySessions(facility.id, CARD_SESSION_LIMIT);
  } catch {
    // A card must not wear a sessions outage: it opens without the игри, as
    // the facility page does (components/facility/facility-sessions.tsx).
  }
  return toFacilityCard(facility, sessions);
}

/**
 * What the map's facility card says beyond the three things the feed carries.
 *
 * The feed (`/api/facilities`) is ~6,000 features and deliberately minimal: a
 * name, the sports and a place. That is enough to draw a pin and a list row,
 * and it was all the card had — a heading and two directions buttons, for a
 * place whose page knows its surface, its lighting, who may use it, when it was
 * last checked, what it looks like and what is played there next.
 *
 * Those facts are asked for ONE FACILITY AT A TIME, when its card opens
 * (`/api/facilities/[slug]/card`), rather than added to the feed: five more
 * properties on every feature would be paid for by every visit, for the few
 * pins a visitor taps, and photos and игри could not ride the feed at all.
 *
 * Client-safe: types, limits and the reader. The query lives in
 * lib/facility-card.ts, which this file never imports.
 */

/** How many photos a card carries. The facility page shows all of them. */
export const CARD_PHOTO_LIMIT = 8;
/** How many upcoming игри a card lists before «Виж детайли» takes over. */
export const CARD_SESSION_LIMIT = 3;

/**
 * A minute in the browser, and no stale-while-revalidate: a member who has just
 * confirmed a place and comes back to the map should not be shown, for an hour,
 * that nobody has. The feed can afford a longer window because it says so
 * little; this says «Последна проверка».
 *
 * Two caches honour that minute — the browser's, and this tab's memory below —
 * so a card can be up to two minutes behind. The one case where that would be
 * a lie the member can see is their own contribution, and that one is read
 * past both (`forgetCard`).
 */
export const CARD_MAX_AGE_S = 60;
export const CARD_CACHE_CONTROL = `public, max-age=${String(CARD_MAX_AGE_S)}`;

export interface FacilityCardSession {
  occurrenceId: string;
  title: string;
  /** ISO instant; the card prints it in Sofia time (lib/format.ts). */
  startsAt: string;
  capacity: number | null;
  going: number;
}

export interface FacilityCardData {
  slug: string;
  access: string;
  /** `needs_verification` reads «Очаква проверка». */
  status: string;
  surface: string | null;
  lighting: boolean | null;
  /** NULL = nobody has said (`coveredKnown` in lib/public-data.ts), never «не». */
  covered: boolean | null;
  condition: string | null;
  lastVerifiedAt: string | null;
  source: string;
  /** Approved photo ids, oldest first — rendered through lib/photo-url.ts. */
  photoIds: string[];
  sessions: FacilityCardSession[];
}

export function facilityCardUrl(slug: string): string {
  return `/api/facilities/${encodeURIComponent(slug)}/card`;
}

/** The facility is unknown or no longer public: asking again will not help. */
export class FacilityCardMissing extends Error {
  constructor(slug: string) {
    super(`facility card missing: ${slug}`);
    this.name = 'FacilityCardMissing';
  }
}

type CardFetch = (
  url: string,
  init: { signal?: AbortSignal; cache: RequestCache },
) => Promise<Response>;

/**
 * Cards already read in this tab, so going back to a pin opens at once instead
 * of flashing its skeleton again. A module variable, not storage: the site
 * keeps nothing on the device without being asked (lib/map/feed.ts says why),
 * and a reload starting empty is exactly right. It honours the same minute the
 * response header promises, and it is bounded — a long session over the whole
 * country must not keep a card for every pin it ever opened.
 */
const KEPT = 40;
const seen = new Map<string, { at: number; card: FacilityCardData }>();
/** Places whose next read must go past the browser's cache too (`forgetCard`). */
const stale = new Set<string>();

/** Drop the oldest entries of an insertion-ordered collection down to `KEPT`. */
function trim(collection: {
  size: number;
  keys(): Iterable<string>;
  delete(key: string): boolean;
}) {
  for (const oldest of collection.keys()) {
    if (collection.size <= KEPT) break;
    collection.delete(oldest);
  }
}

/** The card for `slug` if this tab read it within the last minute. */
export function rememberedCard(slug: string, now: number = Date.now()): FacilityCardData | null {
  const hit = seen.get(slug);
  if (!hit) return null;
  if (now - hit.at > CARD_MAX_AGE_S * 1000) {
    seen.delete(slug);
    return null;
  }
  return hit.card;
}

/**
 * The member is on this facility's PAGE — the one place a card's facts change
 * by their own hand (a confirmation, a condition report, a photo). Whatever
 * this tab remembered about it is dropped, and its next card is read past the
 * browser's copy as well: the card that sent them there with «Били ли сте
 * тук?» must not greet them, a moment later, as if they had not been.
 */
export function forgetCard(slug: string): void {
  seen.delete(slug);
  stale.delete(slug);
  stale.add(slug);
  trim(stale);
}

/** For tests: forget every card. */
export function forgetCards(): void {
  seen.clear();
  stale.clear();
}

/** The shape the card component reads without checking — checked once, here. */
function isCard(value: unknown): value is FacilityCardData {
  if (typeof value !== 'object' || value === null) return false;
  const card = value as Partial<Record<keyof FacilityCardData, unknown>>;
  return (
    typeof card.slug === 'string' &&
    typeof card.access === 'string' &&
    typeof card.status === 'string' &&
    typeof card.source === 'string' &&
    Array.isArray(card.photoIds) &&
    Array.isArray(card.sessions)
  );
}

/**
 * Read one facility's card. Rejects on a failed request — the card keeps its
 * heading and its directions either way, and says the details did not load —
 * with `FacilityCardMissing` when the place is gone (no retry will find it),
 * and with the caller's AbortError when the member has moved to another pin.
 */
export async function loadFacilityCard(options: {
  slug: string;
  signal?: AbortSignal;
  now?: number;
  fetcher?: CardFetch;
}): Promise<FacilityCardData> {
  const { slug } = options;
  const now = options.now ?? Date.now();
  const kept = rememberedCard(slug, now);
  if (kept) return kept;
  const fetcher: CardFetch = options.fetcher ?? ((url, init) => fetch(url, init));
  const response = await fetcher(facilityCardUrl(slug), {
    signal: options.signal,
    cache: stale.has(slug) ? 'reload' : 'default',
  });
  if (response.status === 404) throw new FacilityCardMissing(slug);
  if (!response.ok) throw new Error(`facility card ${String(response.status)}`);
  const card: unknown = await response.json();
  if (!isCard(card)) throw new Error('facility card malformed');
  stale.delete(slug);
  // Under the slug that was ASKED for: that is the key the next read looks up.
  seen.delete(slug);
  seen.set(slug, { at: now, card });
  trim(seen);
  return card;
}

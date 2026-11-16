import type { FacilityFeatureCollection } from '@/lib/public-data';

/**
 * How the map's facility feed (/api/facilities) is cached, and the two moments
 * that cache must be stepped around. Client-safe: types only from the server
 * module, nothing stored on the device.
 *
 * The browser keeps the feed for five minutes and then, for an hour more, hands
 * out the old copy once while it fetches a new one. For somebody browsing that
 * is the right trade: the map opens at once and is at most minutes behind.
 *
 * It is the wrong trade twice:
 *
 *  1. Somebody was SENT to one facility («Покажи на голямата карта», a shared
 *     link) and the cached copy is older than that facility. The map opened on
 *     the right street with no pin and no card.
 *  2. The member has just added a place themselves. Their very next look at
 *     the map is to see it there, and their cache was filled a minute BEFORE
 *     the add, while they were choosing where to drop the pin.
 *
 * Both are answered by asking again past the cache (`cache: 'reload'`, which
 * also replaces the stored copy), never by caching less for everybody.
 */
export const FEED_MAX_AGE_S = 300;
export const FEED_STALE_S = 3600;

/** The response header the route sends — built here so the window below cannot drift from it. */
export const FEED_CACHE_CONTROL = `public, max-age=${String(FEED_MAX_AGE_S)}, stale-while-revalidate=${String(FEED_STALE_S)}`;

/** How long a copy fetched before a change can still be handed out, with a minute to spare. */
export const FEED_CACHE_WINDOW_MS = (FEED_MAX_AGE_S + FEED_STALE_S + 60) * 1000;

/**
 * Until when this tab must read the feed past the cache. A module variable, on
 * purpose: it lives exactly as long as the page does, which is as long as the
 * member's "I just added it, where is it" lasts — and it writes nothing to the
 * device, so the site's no-storage promise is untouched.
 */
let freshUntil = 0;

/** The member changed what the map shows: their next hour of loads skips the cache. */
export function requireFreshFeed(now: number = Date.now()): void {
  freshUntil = now + FEED_CACHE_WINDOW_MS;
}

export function feedMustBeFresh(now: number = Date.now()): boolean {
  return now < freshUntil;
}

/** Tests only. */
export function resetFeedFreshness(): void {
  freshUntil = 0;
}

type FeedFetch = (
  url: string,
  init: { signal?: AbortSignal; cache: RequestCache },
) => Promise<Response>;

/**
 * Load the feed.
 *
 * `wanted` is the facility the visitor was sent to, if any. When the copy we
 * got does not contain it, the feed is asked for ONCE more past the cache: a
 * link to a place added a minute ago then finds it, and a link to a place that
 * is really gone (or outside the filters) costs one extra request and no more.
 */
export async function loadFacilityFeed(options: {
  url: string;
  signal?: AbortSignal;
  wanted?: string | null;
  fresh?: boolean;
  fetcher?: FeedFetch;
}): Promise<FacilityFeatureCollection> {
  const fetcher: FeedFetch = options.fetcher ?? ((url, init) => fetch(url, init));
  const get = async (cache: RequestCache): Promise<FacilityFeatureCollection> => {
    const response = await fetcher(options.url, {
      ...(options.signal ? { signal: options.signal } : {}),
      cache,
    });
    if (!response.ok) throw new Error(`facilities ${String(response.status)}`);
    return (await response.json()) as FacilityFeatureCollection;
  };

  // Past the cache when it can be had; the cached copy when it cannot (offline,
  // a server hiccup). An older map beats an error screen — but a request the
  // caller aborted stays aborted.
  const pastCache = async (
    fallback: () => FacilityFeatureCollection | Promise<FacilityFeatureCollection>,
  ): Promise<FacilityFeatureCollection> => {
    try {
      return await get('reload');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      return fallback();
    }
  };

  if (options.fresh) return pastCache(() => get('default'));
  const cached = await get('default');
  const wanted = options.wanted;
  if (!wanted || cached.features.some((feature) => feature.properties.slug === wanted)) {
    return cached;
  }
  return pastCache(() => cached);
}

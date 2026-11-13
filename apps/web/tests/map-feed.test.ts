import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { accessIncluding, parsePublicFilters } from '@/lib/filters';
import { facilityMapHref } from '@/lib/map/facility-link';
import {
  FEED_CACHE_CONTROL,
  FEED_CACHE_WINDOW_MS,
  feedMustBeFresh,
  loadFacilityFeed,
  requireFreshFeed,
  resetFeedFreshness,
} from '@/lib/map/feed';

/**
 * Two ways the map failed to show a facility it was asked for (2026-11-13):
 *
 *  - «Покажи на голямата карта» on a place that is not free opened the map on
 *    the right street with no pin and no card, because the map draws free
 *    places unless the link says otherwise — and the link said nothing.
 *  - A member who had just added a place opened the map and did not find it:
 *    the browser was still handing out the feed it cached before the add.
 *
 * The free-only default itself is deliberate and stays (the first test).
 */

const HALL = { slug: 'zala-levski', lat: 42.287654321, lon: 24.961234567 };

function feed(...slugs: string[]) {
  return {
    type: 'FeatureCollection' as const,
    features: slugs.map((slug) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [25, 42.5] as [number, number] },
      properties: { slug, name: null, sports: [] },
    })),
  };
}

/** A fetch that answers from a queue and records how each request asked. */
function fakeFetch(...answers: (ReturnType<typeof feed> | number)[]) {
  const calls: { url: string; cache: RequestCache }[] = [];
  const fetcher = (url: string, init: { cache: RequestCache }) => {
    calls.push({ url, cache: init.cache });
    const answer = answers.shift();
    if (answer === undefined) throw new Error('unexpected request');
    return Promise.resolve(
      typeof answer === 'number'
        ? new Response('{}', { status: answer })
        : new Response(JSON.stringify(answer), { status: 200 }),
    );
  };
  return { calls, fetcher };
}

afterEach(() => {
  resetFeedFreshness();
});

describe('the map still opens on free places only', () => {
  it('no access in the address means free, and nothing else', () => {
    expect(parsePublicFilters({}).access).toEqual(['free']);
  });
});

describe('a link that opens the map on one facility', () => {
  it('is the bare link for a free place', () => {
    expect(facilityMapHref({ ...HALL, access: 'free' })).toBe(
      '/karta?selected=zala-levski&z=16&lat=42.28765&lng=24.96123',
    );
  });

  it.each(['restricted', 'school', 'paid'])(
    'brings the kind of access with it for a %s place, so the map draws its pin',
    (access) => {
      const href = facilityMapHref({ ...HALL, access });
      const query = Object.fromEntries(new URL(href, 'https://pops.test').searchParams);
      // What the map will show is what the map itself parses out of the link.
      expect(parsePublicFilters(query).access).toEqual(['free', access]);
      expect(query.selected).toBe('zala-levski');
      expect(query.z).toBe('16');
    },
  );

  it('never passes on a kind of access the map does not know', () => {
    expect(accessIncluding('members-only')).toEqual(['free']);
    expect(facilityMapHref({ ...HALL, access: 'members-only' })).not.toContain('access=');
  });

  it('is the one builder the facility page uses for both of its map links', () => {
    const page = readFileSync(resolve(__dirname, '../app/[locale]/obekt/[slug]/page.tsx'), 'utf8');
    expect(page.match(/facilityMapHref\(facility\)/g)).toHaveLength(2);
    expect(page).not.toContain('/karta?selected=');
  });
});

describe('loading the map feed', () => {
  it('reads through the browser cache when nothing asks otherwise', async () => {
    const { calls, fetcher } = fakeFetch(feed('a', 'b'));
    const result = await loadFacilityFeed({ url: '/api/facilities?locale=bg', fetcher });
    expect(result.features).toHaveLength(2);
    expect(calls).toEqual([{ url: '/api/facilities?locale=bg', cache: 'default' }]);
  });

  it('does not ask twice when the linked facility is in the copy it got', async () => {
    const { calls, fetcher } = fakeFetch(feed('a', 'zala-levski'));
    await loadFacilityFeed({ url: '/f', wanted: 'zala-levski', fetcher });
    expect(calls.map((call) => call.cache)).toEqual(['default']);
  });

  it('asks again past the cache when the linked facility is missing from the cached copy', async () => {
    const { calls, fetcher } = fakeFetch(feed('a'), feed('a', 'zala-levski'));
    const result = await loadFacilityFeed({ url: '/f', wanted: 'zala-levski', fetcher });
    expect(calls.map((call) => call.cache)).toEqual(['default', 'reload']);
    expect(result.features.map((feature) => feature.properties.slug)).toContain('zala-levski');
  });

  it('asks again once only — a link to a place that is gone costs one extra request', async () => {
    const { calls, fetcher } = fakeFetch(feed('a'), feed('a'));
    const result = await loadFacilityFeed({ url: '/f', wanted: 'gone', fetcher });
    expect(calls).toHaveLength(2);
    expect(result.features).toHaveLength(1);
  });

  it('goes straight past the cache after the member’s own add, in one request', async () => {
    const { calls, fetcher } = fakeFetch(feed('a', 'new'));
    await loadFacilityFeed({ url: '/f', wanted: 'new', fresh: true, fetcher });
    expect(calls.map((call) => call.cache)).toEqual(['reload']);
  });

  it('keeps the cached copy when the second, past-the-cache request fails', async () => {
    const { calls, fetcher } = fakeFetch(feed('a'), 503);
    const result = await loadFacilityFeed({ url: '/f', wanted: 'zala-levski', fetcher });
    expect(calls.map((call) => call.cache)).toEqual(['default', 'reload']);
    expect(result.features.map((feature) => feature.properties.slug)).toEqual(['a']);
  });

  it('falls back to the cache when the fresh read fails after the member’s own add', async () => {
    const { calls, fetcher } = fakeFetch(503, feed('a'));
    const result = await loadFacilityFeed({ url: '/f', fresh: true, fetcher });
    expect(calls.map((call) => call.cache)).toEqual(['reload', 'default']);
    expect(result.features).toHaveLength(1);
  });

  it('an aborted request stays aborted — no fallback, nothing set on a dead effect', async () => {
    const aborted = () => Promise.reject(new DOMException('aborted', 'AbortError'));
    await expect(loadFacilityFeed({ url: '/f', fresh: true, fetcher: aborted })).rejects.toThrow(
      'aborted',
    );
  });

  it('fails loudly on an error answer, as the explorer’s retry state expects', async () => {
    const { fetcher } = fakeFetch(503);
    await expect(loadFacilityFeed({ url: '/f', fetcher })).rejects.toThrow('facilities 503');
  });
});

describe('after the member’s own add', () => {
  it('the map reads past the cache for as long as a stale copy could be served', () => {
    const now = 1_800_000_000_000;
    expect(feedMustBeFresh(now)).toBe(false);
    requireFreshFeed(now);
    expect(feedMustBeFresh(now + 1)).toBe(true);
    expect(feedMustBeFresh(now + FEED_CACHE_WINDOW_MS - 1)).toBe(true);
    expect(feedMustBeFresh(now + FEED_CACHE_WINDOW_MS)).toBe(false);
  });

  it('that window covers everything the response header lets a browser keep', () => {
    const seconds = [...FEED_CACHE_CONTROL.matchAll(/=(\d+)/g)].map((match) => Number(match[1]));
    expect(seconds).toHaveLength(2);
    expect(FEED_CACHE_WINDOW_MS).toBeGreaterThan(seconds.reduce((a, b) => a + b, 0) * 1000);
  });

  it('writes nothing to the device', () => {
    const source = readFileSync(resolve(__dirname, '../lib/map/feed.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
  });

  it('the thank-you on the facility page is what switches it on', () => {
    const page = readFileSync(resolve(__dirname, '../app/[locale]/obekt/[slug]/page.tsx'), 'utf8');
    const banner = page.slice(page.indexOf('{addedThanks !== null && ('));
    expect(banner.indexOf('<FreshMapFeed />')).toBeGreaterThan(-1);
    expect(banner.indexOf('<FreshMapFeed />')).toBeLessThan(
      banner.indexOf("tAdd('moderationNoteMap')"),
    );
  });

  it('the explorer loads through the one loader, looking for the linked facility', () => {
    const explorer = readFileSync(resolve(__dirname, '../components/map/map-explorer.tsx'), 'utf8');
    expect(explorer).toMatch(
      /loadFacilityFeed\(\{[\s\S]*?wanted: linkedSlugRef\.current,[\s\S]*?fresh: feedMustBeFresh\(\),/,
    );
    expect(explorer).not.toMatch(/fetch\(`\/api\/facilities/);
  });
});

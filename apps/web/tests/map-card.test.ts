import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '../app/api/facilities/[slug]/card/route';
import { ROOT_CLIENT_NAMESPACES } from '../i18n/client-messages';
import { facilityCard, isoInstant, toFacilityCard } from '../lib/facility-card';
import { ACCESS_OPTIONS } from '../lib/filters';
import {
  CARD_CACHE_CONTROL,
  CARD_MAX_AGE_S,
  CARD_PHOTO_LIMIT,
  CARD_SESSION_LIMIT,
  FacilityCardMissing,
  facilityCardUrl,
  forgetCard,
  forgetCards,
  loadFacilityCard,
  rememberedCard,
  type FacilityCardData,
  type FacilityCardSession,
} from '../lib/map/card';
import type { FacilityDetail } from '../lib/public-data';
import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * The map's facility card (operator request 2026-11-13: «very few details
 * visible when a user clicks on a facility»). The card now reads one
 * facility's facts when it opens. These tests pin the things that could go
 * quietly wrong with that: the card showing something the facility page would
 * not, a date the browser cannot parse, the card asking more than once for the
 * same place, one place's facts under another's name, and the card losing the
 * structure the keyboard and the e2e suite rely on. There is no DOM here, so
 * the component is pinned by its source, as the explorer is.
 */

// The two queries the card is built from. Everything between them and the
// response — the builder and the route — runs for real.
const db = vi.hoisted(() => ({
  facility: vi.fn<(slug: string) => Promise<unknown>>(),
  sessions: vi.fn<(facilityId: string, limit: number) => Promise<unknown[]>>(),
}));
vi.mock('@/lib/public-data', () => ({ getFacilityBySlug: db.facility }));
vi.mock('@/lib/sessions/occurrence', () => ({ facilitySessions: db.sessions }));

const source = (...p: string[]) => readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const cardSource = source('components', 'map', 'facility-card.tsx');
const explorer = source('components', 'map', 'map-explorer.tsx');
const reader = source('lib', 'map', 'card.ts');
const builder = source('lib', 'facility-card.ts');
const facilityPage = source('app', '[locale]', 'obekt', '[slug]', 'page.tsx');

const ROW_ID = '00000000-0000-4000-8000-000000000001';
/** «Last checked» exactly as the facility query hands it over. */
const PG_INSTANT = '2026-10-31 11:20:29.504277+00';

const detail = (over: Partial<FacilityDetail> = {}): FacilityDetail => ({
  id: ROW_ID,
  slug: 'igrishte',
  name: null,
  sportTypes: ['football'],
  surface: 'grass',
  lighting: null,
  covered: false,
  coveredKnown: false,
  access: 'free',
  status: 'needs_verification',
  source: 'osm',
  quarter: null,
  municipalityName: 'Павел баня',
  lon: 25.05,
  lat: 42.66,
  lastVerifiedAt: null,
  condition: null,
  conditionReportedAt: null,
  photoIds: [],
  ...over,
});

const game = (n: number): FacilityCardSession => ({
  occurrenceId: `o-${String(n)}`,
  title: 'Игра',
  startsAt: '2026-11-15T17:00:00.000Z',
  capacity: 10,
  going: n,
});

const card = (slug: string): FacilityCardData => toFacilityCard(detail({ slug }), []);

type Fetcher = (
  url: string,
  init: { signal?: AbortSignal; cache: RequestCache },
) => Promise<Response>;
const answering = (body: unknown, status = 200) =>
  vi.fn<Fetcher>(() => Promise.resolve(new Response(JSON.stringify(body), { status })));

const request = (slug: string) =>
  GET(new Request(`http://localhost/api/facilities/${slug}/card`), {
    params: Promise.resolve({ slug }),
  });

beforeEach(() => {
  forgetCards();
  db.facility.mockReset();
  db.sessions.mockReset();
  db.sessions.mockResolvedValue([]);
});

describe('what the card is told about a facility', () => {
  it('is cut from the facility page’s own record, and no row id leaves', () => {
    const data = toFacilityCard(detail({ condition: 'good', lastVerifiedAt: PG_INSTANT }), []);
    expect(Object.keys(data).sort()).toEqual(
      [
        'access',
        'condition',
        'covered',
        'lastVerifiedAt',
        'lighting',
        'photoIds',
        'sessions',
        'slug',
        'source',
        'status',
        'surface',
      ].sort(),
    );
    expect(JSON.stringify(data)).not.toContain(ROW_ID);
    // One query decides visibility, photos and «last checked»: the page's.
    expect(builder).not.toMatch(/getDb|sql`/);
  });

  it('sends «last checked» as an ISO instant, whatever the database printed', () => {
    // Postgres prints a space and a two-digit offset; `Date` is not required
    // to accept either, and the card is the first to parse this in a browser.
    expect(toFacilityCard(detail({ lastVerifiedAt: PG_INSTANT }), []).lastVerifiedAt).toBe(
      '2026-10-31T11:20:29.504Z',
    );
    expect(isoInstant('2026-10-31 13:20:29+02')).toBe('2026-10-31T11:20:29.000Z');
    expect(isoInstant('2026-10-31T11:20:29.504Z')).toBe('2026-10-31T11:20:29.504Z');
    expect(isoInstant(null)).toBeNull();
    expect(isoInstant('not a date')).toBeNull();
  });

  it('never formats a date it could not read', () => {
    // Intl throws on an invalid date, and a throw in render is the error page.
    expect(cardSource).toMatch(/verifiedAt && !Number\.isNaN\(verifiedAt\.getTime\(\)\)/);
    expect(cardSource).toMatch(/!Number\.isNaN\(Date\.parse\(session\.startsAt\)\)/);
  });

  it('never turns «nobody has said» into «не» for a roof', () => {
    expect(toFacilityCard(detail({ covered: false, coveredKnown: false }), []).covered).toBeNull();
    expect(toFacilityCard(detail({ covered: false, coveredKnown: true }), []).covered).toBe(false);
    expect(toFacilityCard(detail({ covered: true, coveredKnown: true }), []).covered).toBe(true);
  });

  it('carries a bounded number of photos and игри', () => {
    const photoIds = Array.from({ length: 20 }, (_, i) => `photo-${String(i)}`);
    const data = toFacilityCard(
      detail({ photoIds }),
      Array.from({ length: 9 }, (_, i) => game(i)),
    );
    expect(data.photoIds).toEqual(photoIds.slice(0, CARD_PHOTO_LIMIT));
    expect(data.sessions).toHaveLength(CARD_SESSION_LIMIT);
    expect(data.sessions[0]?.occurrenceId).toBe('o-0');
  });
});

describe('building the card from the page’s two queries', () => {
  it('is null for a facility the page would not show', async () => {
    db.facility.mockResolvedValue(null);
    await expect(facilityCard('hidden')).resolves.toBeNull();
    expect(db.sessions).not.toHaveBeenCalled();
  });

  it('asks for the игри of that facility, a few of them', async () => {
    db.facility.mockResolvedValue(detail());
    db.sessions.mockResolvedValue([game(1)]);
    const data = await facilityCard('igrishte');
    expect(db.facility).toHaveBeenCalledWith('igrishte');
    expect(db.sessions).toHaveBeenCalledWith(ROW_ID, CARD_SESSION_LIMIT);
    expect(data?.sessions).toEqual([game(1)]);
  });

  it('opens without игри when their query fails, as the facility page does', async () => {
    db.facility.mockResolvedValue(detail({ surface: 'clay' }));
    db.sessions.mockRejectedValue(new Error('sessions are down'));
    const data = await facilityCard('igrishte');
    expect(data?.surface).toBe('clay');
    expect(data?.sessions).toEqual([]);
  });
});

describe('the card endpoint', () => {
  it('answers a public facility, cached for a minute', async () => {
    db.facility.mockResolvedValue(detail({ lastVerifiedAt: PG_INSTANT }));
    const response = await request('igrishte');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    const body = (await response.json()) as FacilityCardData;
    expect(body.slug).toBe('igrishte');
    expect(body.lastVerifiedAt).toBe('2026-10-31T11:20:29.504Z');
    expect(JSON.stringify(body)).not.toContain(ROW_ID);
  });

  it('answers 404 for a place that is unknown or hidden, and never caches that', async () => {
    db.facility.mockResolvedValue(null);
    const response = await request('paid-venue');
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    // The same body either way: nothing confirms that a hidden place exists.
    await expect(response.json()).resolves.toEqual({ error: 'not_found' });
  });

  it('promises a minute and no longer', () => {
    expect(CARD_CACHE_CONTROL).toBe('public, max-age=60');
    expect(CARD_MAX_AGE_S).toBe(60);
    // No stale-while-revalidate: «Последна проверка» must not lag an hour.
    expect(CARD_CACHE_CONTROL).not.toMatch(/stale/);
  });
});

describe('reading a card', () => {
  it('asks for exactly that facility', async () => {
    const fetcher = answering(card('zala-po-gimnastika'));
    const data = await loadFacilityCard({ slug: 'zala-po-gimnastika', fetcher, now: 0 });
    expect(data.slug).toBe('zala-po-gimnastika');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/facilities/zala-po-gimnastika/card');
    expect(fetcher.mock.calls[0]?.[1].cache).toBe('default');
    expect(facilityCardUrl('a b')).toBe('/api/facilities/a%20b/card');
  });

  it('does not ask again for a place opened within the minute', async () => {
    const fetcher = answering(card('a'));
    await loadFacilityCard({ slug: 'a', fetcher, now: 1_000 });
    await loadFacilityCard({ slug: 'a', fetcher, now: 30_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(rememberedCard('a', 30_000)?.slug).toBe('a');
  });

  it('asks again once the minute has passed', async () => {
    const fetcher = answering(card('a'));
    await loadFacilityCard({ slug: 'a', fetcher, now: 0 });
    expect(rememberedCard('a', CARD_MAX_AGE_S * 1000 + 1)).toBeNull();
    await loadFacilityCard({ slug: 'a', fetcher, now: CARD_MAX_AGE_S * 1000 + 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reads past every cache, once, after the member has been on the place’s page', async () => {
    const fetcher = answering(card('a'));
    await loadFacilityCard({ slug: 'a', fetcher, now: 0 });
    forgetCard('a');
    expect(rememberedCard('a', 1)).toBeNull();
    await loadFacilityCard({ slug: 'a', fetcher, now: 2 });
    expect(fetcher.mock.calls[1]?.[1].cache).toBe('reload');
    // Once: the fresh copy is good for its minute, and after it an ordinary read.
    await loadFacilityCard({ slug: 'a', fetcher, now: 3 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await loadFacilityCard({ slug: 'a', fetcher, now: CARD_MAX_AGE_S * 1000 + 10 });
    expect(fetcher.mock.calls[2]?.[1].cache).toBe('default');
    // Another place is none of this one's business.
    await loadFacilityCard({ slug: 'b', fetcher: answering(card('b')), now: 2 });
    expect(rememberedCard('b', 3)?.slug).toBe('b');
  });

  it('keeps asking past the cache until a read has actually landed', async () => {
    forgetCard('a');
    const failing = answering({}, 500);
    await expect(loadFacilityCard({ slug: 'a', fetcher: failing, now: 0 })).rejects.toThrow();
    const fetcher = answering(card('a'));
    await loadFacilityCard({ slug: 'a', fetcher, now: 1 });
    expect(fetcher.mock.calls[0]?.[1].cache).toBe('reload');
  });

  it('says a place is gone differently from a read that merely failed', async () => {
    const gone = loadFacilityCard({ slug: 'a', fetcher: answering({}, 404), now: 0 });
    await expect(gone).rejects.toBeInstanceOf(FacilityCardMissing);
    const failed = loadFacilityCard({ slug: 'a', fetcher: answering({}, 500), now: 0 });
    await expect(failed).rejects.toThrow('facility card 500');
    await expect(failed).rejects.not.toBeInstanceOf(FacilityCardMissing);
    expect(rememberedCard('a', 1)).toBeNull();
  });

  it('refuses an answer that is not a card, rather than hand it to the renderer', async () => {
    const wrong = answering({ slug: 'a', photoIds: 'none' });
    await expect(loadFacilityCard({ slug: 'a', fetcher: wrong, now: 0 })).rejects.toThrow(
      'facility card malformed',
    );
    expect(rememberedCard('a', 1)).toBeNull();
  });

  it('remembers under the slug that was asked for', async () => {
    await loadFacilityCard({ slug: 'asked', fetcher: answering(card('answered')), now: 0 });
    expect(rememberedCard('asked', 1)?.slug).toBe('answered');
    expect(rememberedCard('answered', 1)).toBeNull();
  });

  it('hands the caller’s signal to the request, so a new pin cancels the old read', async () => {
    const fetcher = answering(card('a'));
    const controller = new AbortController();
    await loadFacilityCard({ slug: 'a', fetcher, signal: controller.signal, now: 0 });
    expect(fetcher.mock.calls[0]?.[1].signal).toBe(controller.signal);
  });

  it('keeps a bounded number of cards, dropping the oldest', async () => {
    for (let i = 0; i < 45; i += 1) {
      const slug = `p-${String(i)}`;
      await loadFacilityCard({ slug, fetcher: answering(card(slug)), now: i });
    }
    expect(rememberedCard('p-0', 50)).toBeNull();
    expect(rememberedCard('p-4', 50)).toBeNull();
    expect(rememberedCard('p-5', 50)?.slug).toBe('p-5');
    expect(rememberedCard('p-44', 50)?.slug).toBe('p-44');
  });

  it('keeps nothing on the device', () => {
    for (const text of [reader, cardSource, source('components', 'map', 'fresh-card.tsx')]) {
      expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
  });

  it('is told to forget a place by that place’s page', () => {
    expect(facilityPage).toMatch(/<FreshFacilityCard slug=\{facility\.slug\} \/>/);
    expect(source('components', 'map', 'fresh-card.tsx')).toMatch(
      /useEffect\(\(\) => \{\s*forgetCard\(slug\);\s*\}, \[slug\]\);/,
    );
  });
});

describe('the explorer reads the details, the card shows them', () => {
  /** The effect that reads the open card, from its first line to its deps. */
  const effect = explorer.slice(
    explorer.indexOf('const [cardAttempt, setCardAttempt]'),
    explorer.indexOf('}, [selectedSlug, cardAttempt]);'),
  );

  it('reads once per opened facility, not once per rendered card', () => {
    // The card is rendered twice (desktop panel, phone sheet): a reader inside
    // it would ask twice for every pin.
    expect(effect.length).toBeGreaterThan(0);
    expect(explorer.match(/loadFacilityCard\(/g)).toHaveLength(1);
    expect(cardSource).not.toMatch(/loadFacilityCard|rememberedCard|fetch\(/);
  });

  it('never paints the previous place’s facts under the next one’s name', () => {
    expect(explorer).toMatch(
      /card\?\.slug === selectedSlug \? card\.details : \{ status: 'loading', data: null \}/,
    );
    expect(explorer).toMatch(/<FacilityCard\s+key=\{selected\.slug\}/);
  });

  it('cancels the read when the selection moves', () => {
    expect(effect).toMatch(/loadFacilityCard\(\{ slug, signal: controller\.signal \}\)/);
    expect(effect).toMatch(/return \(\) => \{\s*controller\.abort\(\);\s*\};/);
  });

  it('drops an answer that lands after the selection has moved', () => {
    // Both handlers, before either writes: a late answer for the old pin would
    // otherwise replace the new pin's card, which then never loads.
    expect(effect).toMatch(
      /\.then\(\(data\) => \{[^}]*if \(controller\.signal\.aborted\) return;\s*setCard\(\{ slug, details: \{ status: 'ready', data \} \}\);/,
    );
    expect(effect).toMatch(
      /\.catch\(\(e: unknown\) => \{\s*if \(controller\.signal\.aborted\) return;/,
    );
  });

  it('offers to try again only when trying again can help', () => {
    expect(effect).toMatch(/const retry = !\(e instanceof FacilityCardMissing\);/);
    expect(effect).toMatch(/details: \{ status: 'error', data: null, retry \}/);
    expect(cardSource).toMatch(/\{details\.status === 'error' && details\.retry && \(/);
  });

  it('keeps the desktop card clear of the map controls, and under their menu', () => {
    expect(explorer).toMatch(/max-h-\[calc\(100dvh-10rem\)\]/);
    // The layer menu opens upward into the card's corner.
    expect(explorer).toMatch(/lg:top-auto lg:bottom-6 lg:z-30/);
  });
});

/**
 * Found while testing the card's links, and already live before it: the map
 * writes its position into the address bar when it stops moving, and it can
 * stop moving after a link has been followed. On pops.bg, «Виж детайли»
 * clicked within half a second of opening a card did nothing (the write told
 * the router the address was the map's again), and a later one put
 * `?z=…&lat=…&lng=…` on the facility page and dropped its `#anchor` — which is
 * exactly where the card's «Били ли сте тук?» sends people.
 */
describe('a link out of the map is not written over by the map', () => {
  const moveEnd = explorer.slice(
    explorer.indexOf('const onMoveEndRef = useRef((view: MapView) => {'),
    explorer.indexOf('function locate()'),
  );

  it('keeps its position to itself once a link away has been followed', () => {
    expect(moveEnd.length).toBeGreaterThan(0);
    expect(moveEnd).toMatch(/if \(leavingRef\.current\) return;/);
    // …and both guards come before the write.
    expect(moveEnd.indexOf('leavingRef.current')).toBeLessThan(moveEnd.indexOf('replaceState'));
    expect(moveEnd.indexOf('mapPathRef.current')).toBeLessThan(moveEnd.indexOf('replaceState'));
  });

  it('never writes its view onto another page’s address', () => {
    expect(explorer).toMatch(
      /useEffect\(\(\) => \{\s*mapPathRef\.current = window\.location\.pathname;\s*\}, \[\]\);/,
    );
    expect(moveEnd).toMatch(
      /if \(mapPathRef\.current !== null && window\.location\.pathname !== mapPathRef\.current\) return;/,
    );
  });

  it('notes the click before the link starts its navigation', () => {
    expect(explorer).toMatch(/onClickCapture=\{noteLeaving\}/);
  });

  it('counts only a click that really leaves this page', () => {
    const note = explorer.slice(
      explorer.indexOf('function noteLeaving('),
      explorer.indexOf('const onMoveEndRef'),
    );
    // A new tab or a download leaves the map where it is…
    expect(note).toMatch(/event\.button !== 0 \|\| event\.metaKey \|\| event\.ctrlKey/);
    expect(note).toMatch(
      /link\.target === '_blank' \|\| link\.origin !== window\.location\.origin/,
    );
    // …and so does a link to the map itself (the cookie-settings anchor).
    expect(note).toMatch(/if \(link\.pathname === window\.location\.pathname\) return;/);
  });

  it('goes back to recording its view if the page never came', () => {
    expect(explorer).toMatch(
      /leavingRef\.current = true;\s*window\.setTimeout\(\(\) => \{\s*leavingRef\.current = false;\s*\}, LEAVING_MS\);/,
    );
    expect(explorer).toMatch(/const LEAVING_MS = 8000;/);
  });
});

describe('the card’s structure', () => {
  it('has one heading, and it is where focus lands', () => {
    // JSX tags only (a line that opens with one): the file's own notes name the tag too.
    expect(cardSource.match(/^\s*<h2\b/gm)).toHaveLength(1);
    expect(cardSource).toMatch(/<h2\s+tabIndex=\{-1\}\s+data-preview-heading/);
    expect(explorer).toMatch(/querySelector<HTMLElement>\('\[data-preview-heading\]'\)/);
  });

  it('never drops focus when a control takes itself away', () => {
    // The photo tile (the sheet grows, the tile is gone) and «Опитай пак» (the
    // notice gives way to placeholders) both hand focus back to the heading.
    expect(cardSource).toMatch(/onExpand\(\);\s*focusHeading\(\);/);
    expect(cardSource).toMatch(/onRetry\(\);\s*focusHeading\(\);/);
    expect(cardSource).toMatch(
      /const focusHeading = \(\) => headingRef\.current\?\.focus\(\{ preventScroll: true \}\);/,
    );
    // The photo steps stay where they are at either end, marked unavailable.
    expect(cardSource).toMatch(
      /aria-disabled=\{disabled\}\s*onClick=\{disabled \? undefined : onClick\}/,
    );
    expect(cardSource).not.toMatch(/disabled:hidden/);
  });

  it('counts photo steps from where the strip is headed, not from where it is', () => {
    expect(cardSource).toMatch(/go\(aim\.current \+ \(event\.key === 'ArrowRight' \? 1 : -1\)\)/);
    expect(cardSource).toMatch(/onClick=\{\(\) => go\(aim\.current \+ 1\)\}/);
    expect(cardSource).toMatch(/onClick=\{\(\) => go\(aim\.current - 1\)\}/);
  });

  it('has one way to the facility page, named «Виж детайли»', () => {
    expect(cardSource.match(/t\('viewDetails'\)/g)).toHaveLength(1);
    expect(cardSource).toMatch(
      /<Link href=\{`\/obekt\/\$\{point\.slug\}`\}>\s*\{t\('viewDetails'\)\}/,
    );
    expect(bg.Map.viewDetails).toBe('Виж детайли');
  });

  it('offers directions as plain links that open the navigation app', () => {
    expect(cardSource).toMatch(
      /href=\{provider\.href\(point\.lat, point\.lon\)\}\s*target="_blank"\s*rel="noopener noreferrer"\s*aria-label=\{t\('directionsWith', \{ app: provider\.brand \}\)\}/,
    );
    expect(cardSource).not.toMatch(/window\.open/);
  });

  it('announces a failed read from a region that was already on the page', () => {
    // A live region that arrives together with its words is not announced.
    expect(cardSource).toMatch(
      /<p id=\{errorId\} role="status" className="sr-only">\s*\{details\.status === 'error' \? t\('card\.detailsError'\) : ''\}/,
    );
    expect(cardSource).toMatch(/aria-describedby=\{errorId\}/);
    // The placeholders say nothing.
    expect(cardSource).toMatch(/<div aria-hidden className="grid grid-cols-3 gap-2">/);
  });

  it('shares the facility page, never the member’s map view', () => {
    expect(cardSource).toMatch(/getPathname\(\{ href: `\/obekt\/\$\{point\.slug\}`, locale \}\)/);
    expect(cardSource).not.toMatch(/window\.location\.(href|search)/);
  });

  it('adds no analytics event and no commercial mark', () => {
    // The vocabulary is closed (lib/analytics-events.ts) and sponsorship stays
    // on the facility page (CLAUDE.md, Monetisation).
    expect(cardSource).not.toMatch(/data-umami-event|umami|sponsor|AdSlot|partner/i);
  });

  it('links «Били ли сте тук?» to the contribute block of the facility page', () => {
    expect(cardSource).toMatch(/href=\{`\/obekt\/\$\{point\.slug\}#prinos`\}/);
    expect(facilityPage).toMatch(/<SectionCard title=\{tContribute\('title'\)\} id="prinos">/);
  });
});

describe('the card’s words', () => {
  it('names every kind of access, in both languages', () => {
    for (const access of ACCESS_OPTIONS) {
      expect(bg.Map.card.access[access], access).toBeTruthy();
      expect(en.Map.card.access[access], access).toBeTruthy();
    }
    expect(bg.Map.card.access.free).toBe('Свободен достъп');
  });

  it('addresses the reader formally', () => {
    expect(bg.Map.card.verifyNudge).toBe('Били ли сте тук? Помогнете да потвърдим данните.');
  });

  it('reads only namespaces every page sends to the browser', () => {
    // The map is the home page: its card has no route scope of its own
    // (tests/i18n-client-namespaces.test.ts walks the real import graph).
    const used = [...cardSource.matchAll(/useTranslations\('(\w+)'\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const namespace of used) {
      expect(ROOT_CLIENT_NAMESPACES as readonly string[], namespace).toContain(namespace);
    }
    // «Session» is 3.5 KB of copy for two strings; the card keeps its own.
    expect(used).not.toContain('Session');
  });
});

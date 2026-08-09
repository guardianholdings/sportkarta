/* POPS service worker: app shell + offline fallback + last-viewport tile
 * cache with a conservative budget. Registered in production only.
 * v2: POPS rebrand — /icons/* pixels changed under unchanged paths, and this
 * cache serves them cache-first with no revalidation, so the version bump is
 * what makes installed clients drop the old teal icons. */
const VERSION = 'v2';
const APP_CACHE = `sk-app-${VERSION}`;
const STATIC_CACHE = `sk-static-${VERSION}`;
const TILE_CACHE = `sk-tiles-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png'];
const TILE_BUDGET = 64; // cap on cached tile ranges (conservative)

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([APP_CACHE, STATIC_CACHE, TILE_CACHE]);
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

// FIFO trim (CacheStorage keys are insertion-ordered) to bound the tile cache.
async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) {
    await cache.delete(keys[i]);
  }
}

// Tiles come back as HTTP Range 206 responses, which the Cache API refuses to
// store. Cache the partial body as a synthetic 200 whose Content-Length equals
// the requested range length — pmtiles.js accepts that. Key by URL + range so
// distinct ranges never collide.
function tileKey(request) {
  const url = new URL(request.url);
  url.searchParams.set('__swr', request.headers.get('range') || 'full');
  return url.toString();
}

// Stale-while-revalidate: serve the cached range immediately (fast pan/zoom),
// refresh it in the background. Only 206 range responses are cached — a full
// 200 archive would buffer tens of MB into one entry. Cache writes are
// best-effort so a storage-quota rejection never fails the tile.
function handleTile(event) {
  event.respondWith(
    (async () => {
      const cache = await caches.open(TILE_CACHE);
      const key = tileKey(event.request);
      const cached = await cache.match(key);

      const revalidate = fetch(event.request)
        .then(async (response) => {
          if (response.status === 206) {
            try {
              const buffer = await response.clone().arrayBuffer();
              await cache.put(
                key,
                new Response(buffer, {
                  status: 200,
                  headers: {
                    'Content-Type':
                      response.headers.get('content-type') || 'application/octet-stream',
                    'Content-Length': String(buffer.byteLength),
                  },
                }),
              );
              void trim(TILE_CACHE, TILE_BUDGET);
            } catch {
              // best-effort cache write (e.g. storage quota) — ignore
            }
          }
          return response;
        })
        .catch(() => cached);

      if (cached) {
        event.waitUntil(revalidate);
        return cached;
      }
      return (await revalidate) || Response.error();
    })(),
  );
}

async function handleStatic(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) void cache.put(request, response.clone());
  return response;
}

async function handleNavigate(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(APP_CACHE);
    return (await cache.match(OFFLINE_URL)) || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/tiles/')) {
    handleTile(event);
  } else if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(handleStatic(request));
  } else if (request.mode === 'navigate') {
    event.respondWith(handleNavigate(request));
  }
});

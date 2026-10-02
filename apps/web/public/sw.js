/* POPS service worker: app shell + offline fallback + last-viewport tile
 * cache with a conservative budget. Registered in production only.
 * v2: POPS rebrand — /icons/* pixels changed under unchanged paths, and this
 * cache serves them cache-first with no revalidation, so the version bump is
 * what makes installed clients drop the old teal icons.
 * v3: cached tile ranges now keep the archive's ETag (see handleTile); the
 * bump drops the v2 ranges, which had none and so could never be told apart
 * from a rebuilt basemap. */
const VERSION = 'v3';
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

// The archive a cached range belongs to: its key without the range marker.
function archiveOf(key) {
  const url = new URL(key);
  url.searchParams.delete('__swr');
  return url.toString();
}

// The archive's identity. Caddy's file_server derives it from the file's size
// and modification time, so a regenerated basemap under the same URL gets a
// new one. Weak validators are ignored, as pmtiles.js ignores them.
function strongEtag(response) {
  const etag = response ? response.headers.get('etag') : null;
  return etag && !etag.startsWith('W/') ? etag : null;
}

// The validators carried over onto the synthetic cached copy. pmtiles.js
// compares the ETag of every range it reads with the one its header came with,
// and that check is the ONLY thing that notices a rebuilt archive: without it
// a cached header and root directory from the old file are used to read tile
// bytes at old offsets in the new one — blank or garbled tiles.
const VALIDATORS = ['etag', 'last-modified'];

// The basemap was rebuilt: every cached range of the old file is now bytes at
// the wrong offsets, so all of them go, not just the one that noticed.
async function dropOtherVersions(cache, archive, etag) {
  const keys = await cache.keys();
  await Promise.all(
    keys.map(async (request) => {
      if (archiveOf(request.url) !== archive) return;
      if (strongEtag(await cache.match(request)) !== etag) await cache.delete(request);
    }),
  );
}

// Stale-while-revalidate: serve the cached range immediately (fast pan/zoom),
// refresh it in the background. Only 206 range responses are cached — a full
// 200 archive would buffer tens of MB into one entry. Cache writes are
// best-effort so a storage-quota rejection never fails the tile.
//
// Except when the page asks to RELOAD. pmtiles.js does that after an ETag
// mismatch — its way of saying "what I read before belongs to another
// version of this file". Answering from the cache would hand it the same stale
// bytes and the retry would fail the same way, so those requests go to the
// network first, and the fresh range replaces the cached one.
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
              const etag = strongEtag(response);
              if (etag && cached && strongEtag(cached) !== etag) {
                await dropOtherVersions(cache, archiveOf(key), etag);
              }
              const buffer = await response.clone().arrayBuffer();
              const headers = {
                'Content-Type': response.headers.get('content-type') || 'application/octet-stream',
                'Content-Length': String(buffer.byteLength),
              };
              for (const name of VALIDATORS) {
                const value = response.headers.get(name);
                if (value) headers[name] = value;
              }
              await cache.put(key, new Response(buffer, { status: 200, headers }));
              void trim(TILE_CACHE, TILE_BUDGET);
            } catch {
              // best-effort cache write (e.g. storage quota) — ignore
            }
          }
          return response;
        })
        .catch(() => cached);

      if (cached && event.request.cache !== 'reload') {
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

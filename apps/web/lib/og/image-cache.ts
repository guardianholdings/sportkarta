import { createHash } from 'node:crypto';

/**
 * An in-process cache of rendered PUBLIC share images (pre-launch audit,
 * finding 163).
 *
 * WHY. satori + resvg rasterise synchronously on the web server's one Node
 * thread: 100-160 ms for a 1200×630 card, 220-410 ms for a 1080×1920 story,
 * during which every other request — sign-in, the map, /api/health — waits.
 * The routes already tell the world the PNG is immutable for a year, but
 * nothing between the scraper and Next honours that (Caddy does not cache), so
 * every Viber, Facebook, WhatsApp and Telegram scrape of a shared link, and
 * every crawler following og:image, paid a full render. Now the first request
 * pays it and the rest are a buffer copy.
 *
 * KEYED BY CONTENT, NOT BY URL. The key is a hash of everything the renderer
 * draws — the localised strings, the stats, the accent — so a renamed facility,
 * a moved session or an edited campaign blurb is simply a different key, and
 * there is no "last edit time" to look up or forget to bump. The route still
 * runs its (cheap, ~5 ms) lookup to learn what to draw; only the rasterising is
 * skipped. A stale entry is never served — it just ages out of the LRU.
 *
 * CONCURRENT REQUESTS SHARE ONE RENDER. A link pasted into a busy group chat is
 * fetched by several platforms within the same second; the entry is the
 * in-flight promise, so they all wait on a single rasterisation. A render that
 * fails is dropped, never cached, and the next request tries again.
 *
 * BOUNDED in both entries and bytes (a card is ~30 KB, a story ~100 KB), and
 * least-recently-used goes first, so a crawler walking all ~6.7k facilities in
 * two locales cannot grow the process without limit.
 *
 * PUBLIC IMAGES ONLY — see `cachedOgCard` / `cachedStoryCard`, which refuse a
 * headers override. A person-scoped image must never be written down anywhere
 * (migration 0012), and keeping it in memory is writing it down.
 */

export interface ImageCacheLimits {
  maxEntries: number;
  maxBytes: number;
}

export const OG_IMAGE_CACHE_LIMITS: ImageCacheLimits = {
  maxEntries: 500,
  maxBytes: 32 * 1024 * 1024,
};

interface Rendered {
  body: Uint8Array;
  headers: [string, string][];
  status: number;
}

interface Entry {
  rendered: Promise<Rendered>;
  /** 0 while the render is in flight; counted once it lands. */
  bytes: number;
}

export interface ImageCache {
  /** Serve `key` from the cache, rendering it with `render` on a miss. */
  get(key: string, render: () => Response): Promise<Response>;
  /** Entries and bytes currently held — for tests and diagnostics. */
  size(): { entries: number; bytes: number };
  clear(): void;
}

async function settle(response: Response): Promise<Rendered> {
  return {
    body: new Uint8Array(await response.arrayBuffer()),
    headers: [...response.headers.entries()],
    status: response.status,
  };
}

export function createImageCache(limits: ImageCacheLimits): ImageCache {
  // A Map iterates in insertion order, so re-inserting on every hit makes the
  // first key the least recently used.
  const entries = new Map<string, Entry>();
  let totalBytes = 0;

  function evict(): void {
    for (const [key, entry] of entries) {
      if (entries.size <= limits.maxEntries && totalBytes <= limits.maxBytes) return;
      entries.delete(key);
      totalBytes -= entry.bytes;
    }
  }

  return {
    async get(key, render) {
      let entry = entries.get(key);
      if (entry) {
        entries.delete(key);
        entries.set(key, entry);
      } else {
        const created: Entry = {
          rendered: Promise.resolve().then(() => settle(render())),
          bytes: 0,
        };
        entry = created;
        entries.set(key, created);
        created.rendered.then(
          (rendered) => {
            // Evicted while rendering: it was never counted, so nothing to add.
            if (entries.get(key) !== created) return;
            if (rendered.status !== 200) {
              entries.delete(key);
              return;
            }
            created.bytes = rendered.body.byteLength;
            totalBytes += created.bytes;
            evict();
          },
          () => {
            if (entries.get(key) === created) entries.delete(key);
          },
        );
        evict();
      }
      const { body, headers, status } = await entry.rendered;
      // A copy per response: the cached bytes are never handed out to be consumed.
      return new Response(body.slice(), { status, headers });
    },
    size() {
      return { entries: entries.size, bytes: totalBytes };
    },
    clear() {
      entries.clear();
      totalBytes = 0;
    },
  };
}

/** The process-wide cache the public card and story routes share. */
export const ogImageCache = createImageCache(OG_IMAGE_CACHE_LIMITS);

/**
 * A stable key for one image: the renderer's name plus its whole input. The
 * input is plain strings, numbers and arrays built in a fixed order by the
 * route, so the same content always serialises the same way.
 */
export function ogImageKey(renderer: 'card' | 'story', input: object): string {
  return createHash('sha256')
    .update(renderer)
    .update('\0')
    .update(JSON.stringify(input))
    .digest('hex');
}

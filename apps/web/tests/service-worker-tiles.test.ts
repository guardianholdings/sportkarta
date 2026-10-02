import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

/**
 * The service worker's tile cache keeps the archive's ETag, so a rebuilt
 * basemap is detected rather than read at the old file's offsets (pre-launch
 * audit, finding 123).
 *
 * pmtiles.js reads the archive as HTTP ranges and compares the ETag of every
 * range with the one its header came with; on a mismatch it re-asks with
 * `cache: 'reload'`. The worker used to cache each range as a synthetic
 * response with NO ETag, served cache-first — so the check never fired, and a
 * returning visitor after a basemap rebuild got old directory offsets applied
 * to the new file: blank or garbled tiles.
 *
 * The worker runs here as-is (public/sw.js is shipped unbundled) inside a VM
 * context with a minimal CacheStorage and fetch, and is driven by fetch events
 * the way the browser drives it.
 */

const SW_SOURCE = readFileSync(path.join(process.cwd(), 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://pops.example';
const ARCHIVE = `${ORIGIN}/tiles/bulgaria.pmtiles`;

class FakeCache {
  readonly store = new Map<string, Response>();
  async match(key: string | Request) {
    const hit = this.store.get(typeof key === 'string' ? key : key.url);
    return hit?.clone();
  }
  async put(key: string | Request, response: Response) {
    this.store.set(typeof key === 'string' ? key : key.url, response.clone());
  }
  async delete(key: string | Request) {
    return this.store.delete(typeof key === 'string' ? key : key.url);
  }
  async keys() {
    return [...this.store.keys()].map((url) => new Request(url));
  }
  async addAll() {
    // The install-time precache is not under test.
  }
}

interface Network {
  etag: string;
  online: boolean;
  requests: { range: string | null; cache: RequestCache }[];
}

function startWorker(network: Network) {
  const caches = new Map<string, FakeCache>();
  const listeners = new Map<string, (event: unknown) => void>();
  const context = vm.createContext({
    URL,
    Request,
    Response,
    Headers,
    Promise,
    console,
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener),
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve() },
    },
    caches: {
      open: async (name: string) => {
        if (!caches.has(name)) caches.set(name, new FakeCache());
        return caches.get(name);
      },
      keys: async () => [...caches.keys()],
      delete: async (name: string) => caches.delete(name),
    },
    // Caddy's file_server: a 206 for any range, stamped with the file's ETag.
    fetch: async (request: Request) => {
      network.requests.push({ range: request.headers.get('range'), cache: request.cache });
      if (!network.online) throw new TypeError('Failed to fetch');
      const range = request.headers.get('range') ?? '';
      return new Response(`${network.etag}:${range}`, {
        status: 206,
        headers: {
          'Content-Type': 'application/octet-stream',
          ETag: network.etag,
          'Last-Modified': 'Thu, 01 Oct 2026 10:00:00 GMT',
        },
      });
    },
  });
  vm.runInContext(SW_SOURCE, context);

  async function get(range: string, cache: RequestCache = 'default') {
    const request = new Request(ARCHIVE, { headers: { range }, cache });
    let responded: Promise<Response> | undefined;
    const background: Promise<unknown>[] = [];
    listeners.get('fetch')?.({
      request,
      respondWith: (response: Promise<Response>) => (responded = response),
      waitUntil: (work: Promise<unknown>) => background.push(work),
    });
    if (!responded) throw new Error('the worker did not answer a tile request');
    const response = await responded;
    await Promise.all(background);
    // Let the best-effort cache write that follows a network answer settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { response, body: await response.clone().text() };
  }

  const tileCache = () => [...caches.entries()].find(([name]) => name.startsWith('sk-tiles-'))?.[1];
  return { get, tileCache };
}

describe('service worker tile cache', () => {
  it('keeps the ETag and Last-Modified on the cached copy of a range', async () => {
    const network: Network = { etag: '"build-1"', online: true, requests: [] };
    const sw = startWorker(network);
    await sw.get('bytes=0-16383');
    const cached = await sw.get('bytes=0-16383');
    // Served from the cache (stale-while-revalidate) — and still identifiable.
    expect(cached.response.status).toBe(200);
    expect(cached.response.headers.get('etag')).toBe('"build-1"');
    expect(cached.response.headers.get('last-modified')).toBe('Thu, 01 Oct 2026 10:00:00 GMT');
    expect(cached.body).toBe('"build-1":bytes=0-16383');
  });

  it("answers pmtiles' reload from the network, not the stale copy", async () => {
    const network: Network = { etag: '"build-1"', online: true, requests: [] };
    const sw = startWorker(network);
    await sw.get('bytes=0-16383');

    network.etag = '"build-2"'; // the basemap is regenerated under the same URL
    const stale = await sw.get('bytes=0-16383');
    expect(stale.response.headers.get('etag')).toBe('"build-1"'); // cache-first, as before

    // pmtiles saw the mismatch and retries with cache: 'reload'.
    const fresh = await sw.get('bytes=0-16383', 'reload');
    expect(fresh.response.headers.get('etag')).toBe('"build-2"');
    expect(fresh.body).toBe('"build-2":bytes=0-16383');
    expect(network.requests.at(-1)?.cache).toBe('reload');
  });

  it('drops every cached range of the old archive once a rebuild is seen', async () => {
    const network: Network = { etag: '"build-1"', online: true, requests: [] };
    const sw = startWorker(network);
    await sw.get('bytes=0-16383');
    await sw.get('bytes=16384-20000');
    await sw.get('bytes=90000-91000');
    expect(sw.tileCache()?.store.size).toBe(3);

    network.etag = '"build-2"';
    // The background revalidation of ONE range notices the new ETag…
    await sw.get('bytes=0-16383');
    // …and the old file's other ranges are gone with it, not served next time.
    const cache = sw.tileCache();
    expect(cache?.store.size).toBe(1);
    const left = await cache?.match([...(cache?.store.keys() ?? [])][0] ?? '');
    expect(left?.headers.get('etag')).toBe('"build-2"');

    const next = await sw.get('bytes=16384-20000');
    expect(next.response.headers.get('etag')).toBe('"build-2"');
  });

  it('still serves the cached range on a reload when offline', async () => {
    const network: Network = { etag: '"build-1"', online: true, requests: [] };
    const sw = startWorker(network);
    await sw.get('bytes=0-16383');
    network.online = false;
    const offline = await sw.get('bytes=0-16383', 'reload');
    expect(offline.body).toBe('"build-1":bytes=0-16383');
  });
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { cachedOgCard, type OgCardInput } from '../lib/og/card';
import { createImageCache, ogImageCache, ogImageKey } from '../lib/og/image-cache';
import { cachedStoryCard, type StoryCardInput } from '../lib/og/story';

/**
 * Public share images are rasterised once per content, not once per request
 * (pre-launch audit, finding 163): satori + resvg ran 100-400 ms on the one Node
 * thread for every scrape of a shared link, stalling every other request.
 */

const WEB_ROOT = process.cwd(); // vitest runs with cwd = apps/web

function png(bytes: number[]): Response {
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, immutable, no-transform, max-age=31536000',
    },
  });
}

async function bytesOf(response: Response): Promise<number[]> {
  return [...new Uint8Array(await response.arrayBuffer())];
}

describe('image cache', () => {
  it('renders a key once and serves the same bytes and headers after', async () => {
    const cache = createImageCache({ maxEntries: 10, maxBytes: 1_000 });
    let renders = 0;
    const render = () => {
      renders += 1;
      return png([1, 2, 3]);
    };
    const first = await cache.get('a', render);
    const second = await cache.get('a', render);
    expect(renders).toBe(1);
    expect(await bytesOf(first)).toEqual([1, 2, 3]);
    expect(await bytesOf(second)).toEqual([1, 2, 3]);
    expect(second.status).toBe(200);
    expect(second.headers.get('content-type')).toBe('image/png');
    expect(second.headers.get('cache-control')).toContain('max-age=31536000');
  });

  it('makes concurrent requests for one image share a single render', async () => {
    // A link pasted into a group chat is scraped by several platforms at once.
    const cache = createImageCache({ maxEntries: 10, maxBytes: 1_000 });
    let renders = 0;
    const render = () => {
      renders += 1;
      return png([9]);
    };
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => cache.get('k', render)));
    expect(renders).toBe(1);
    for (const response of all) expect(await bytesOf(response)).toEqual([9]);
  });

  it('never caches a failed render', async () => {
    const cache = createImageCache({ maxEntries: 10, maxBytes: 1_000 });
    await expect(
      cache.get('x', () => {
        throw new Error('satori failed');
      }),
    ).rejects.toThrow('satori failed');
    expect(cache.size().entries).toBe(0);
    expect(await bytesOf(await cache.get('x', () => png([7])))).toEqual([7]);
  });

  it('evicts the least recently used entry past the entry limit', async () => {
    const cache = createImageCache({ maxEntries: 2, maxBytes: 1_000 });
    let renders = 0;
    const render = () => {
      renders += 1;
      return png([renders]);
    };
    await cache.get('a', render);
    await cache.get('b', render);
    await cache.get('a', render); // a is now the most recently used
    await cache.get('c', render); // evicts b, not a
    expect(renders).toBe(3);
    await cache.get('a', render);
    expect(renders).toBe(3);
    await cache.get('b', render);
    expect(renders).toBe(4);
    expect(cache.size().entries).toBe(2);
  });

  it('holds no more bytes than its budget', async () => {
    const cache = createImageCache({ maxEntries: 100, maxBytes: 10 });
    for (const key of ['a', 'b', 'c', 'd']) await cache.get(key, () => png([0, 0, 0, 0]));
    // Each settled entry is counted once it lands; let the bookkeeping run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const { entries, bytes } = cache.size();
    expect(bytes).toBeLessThanOrEqual(10);
    expect(entries).toBe(2);
  });

  it('keys by everything drawn, so an edit is a new image', () => {
    const base = { title: 'Фитнес на открито', wordmark: 'POPS', subtitle: 'фитнес' };
    expect(ogImageKey('card', base)).toBe(ogImageKey('card', { ...base }));
    expect(ogImageKey('card', base)).not.toBe(ogImageKey('card', { ...base, subtitle: 'бягане' }));
    // The same strings drawn by the other renderer are a different image.
    expect(ogImageKey('card', base)).not.toBe(ogImageKey('story', base));
  });
});

describe('cached public renderers', () => {
  beforeEach(() => {
    ogImageCache.clear();
  });

  it('serves a real card once rendered, byte for byte', { timeout: 30_000 }, async () => {
    const input = { title: 'Южен парк', eyebrow: 'София', wordmark: 'POPS' };
    const first = Buffer.from(await (await cachedOgCard(input)).arrayBuffer());
    expect(ogImageCache.size().entries).toBe(1);
    const again = await cachedOgCard({ ...input });
    expect(Buffer.from(await again.arrayBuffer()).equals(first)).toBe(true);
    expect(again.headers.get('content-type')).toBe('image/png');
    // The public header survives the cache — scrapers and browsers still keep it.
    expect(again.headers.get('cache-control')).toMatch(/public.*max-age=\d{7,}/);
    expect(ogImageCache.size().entries).toBe(1);
  });

  it('refuses a person-scoped image, whatever the types say', () => {
    // A headers override is how a person-scoped card marks itself no-store;
    // such an image must never be kept, in a CDN or in this process.
    const privateHeaders = { 'Cache-Control': 'private, no-store' };
    const card = { title: 'x', wordmark: 'POPS', headers: privateHeaders } as OgCardInput;
    const story = { title: 'x', wordmark: 'POPS', headers: privateHeaders } as StoryCardInput;
    expect(() => cachedOgCard(card)).toThrow(/public/);
    expect(() => cachedStoryCard(story)).toThrow(/public/);
    expect(ogImageCache.size().entries).toBe(0);
  });
});

describe('which routes use the cache', () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (/\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  }

  const ogRoutes = walk(path.join(WEB_ROOT, 'app', 'og')).map((file) => ({
    file: path.relative(WEB_ROOT, file),
    source: readFileSync(file, 'utf8'),
  }));
  const personScoped = ogRoutes.filter(({ file }) => file.includes(`${path.sep}lichen${path.sep}`));
  const publicRoutes = ogRoutes.filter(({ file }) => !personScoped.some((p) => p.file === file));

  it('finds both kinds of route', () => {
    expect(personScoped.length).toBeGreaterThan(0);
    expect(publicRoutes.length).toBeGreaterThan(0);
  });

  it('keeps every person-scoped image out of the cache', () => {
    for (const { file, source } of personScoped) {
      expect(source, file).not.toMatch(/cachedOgCard|cachedStoryCard|ogImageCache/);
    }
  });

  it('renders every public image through the cache', () => {
    // A bare renderOgCard/renderStoryCard here is the per-request render the
    // audit measured, back again.
    for (const { file, source } of publicRoutes) {
      expect(source, file).toMatch(/cachedOgCard|cachedStoryCard/);
      expect(source, file).not.toMatch(/\brender(OgCard|StoryCard)\(/);
    }
  });
});

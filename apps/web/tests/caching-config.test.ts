import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import { describe, expect, it } from 'vitest';

import { PARTNER_SURFACES } from '@/lib/partner-surfaces';

import nextConfig from '../next.config';

/**
 * What the server is allowed to cache, and for how long (pre-launch audit,
 * findings 162, 125 and 157). Each of these failed SILENTLY in production: the
 * code said "cached hourly" and every request rendered anyway; the glyphs were
 * immutable in practice and revalidated on every map load.
 */

const WEB_ROOT = process.cwd(); // vitest runs with cwd = apps/web
const APP_DIR = path.join(WEB_ROOT, 'app');
const PARTNERS_ADMIN = path.join(APP_DIR, '[locale]', 'admin', '(protected)', 'partnyori');

/**
 * What a page shows of a partner: an ad slot (rendered in place, or resolved
 * server-side for the map panel), the headline strip, a campaign's sponsor
 * line, a facility adoption. Each of them reads `PARTNER_RENDERABLE`.
 */
const PARTNER_CONTENT =
  /<AdSlot\b|adSlotProps\(|<HeadlineStrip\b|<CampaignSponsor\b|<FacilitySponsorBlock\b/;

/** A page's own source plus the modules it imports from its own folders. */
function withLocalImports(file: string, source: string): string {
  const sources = [source];
  for (const [, spec] of source.matchAll(/from '(\.\.?\/[^']+)'/g)) {
    const base = path.resolve(path.dirname(file), spec ?? '');
    const found = [`${base}.tsx`, `${base}.ts`].find((candidate) => existsSync(candidate));
    if (found) sources.push(readFileSync(found, 'utf8'));
  }
  return sources.join('\n');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/^(page|route)\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('declared ISR actually caches', () => {
  // Every page or route handler that declares a revalidation window.
  const isr = walk(APP_DIR)
    .map((file) => ({ file: path.relative(APP_DIR, file), source: readFileSync(file, 'utf8') }))
    .filter(({ source }) => /export const revalidate = [1-9]/.test(source));

  it('finds the programmatic SEO pages and the child sitemaps', () => {
    const files = isr.map(({ file }) => file.split(path.sep).join('/'));
    expect(files).toEqual(
      expect.arrayContaining([
        '[locale]/igrishta/[city]/page.tsx',
        '[locale]/igrishta/[city]/[segment]/page.tsx',
        '[locale]/sedmitsata/[city]/page.tsx',
        'sitemaps/[name]/route.ts',
      ]),
    );
  });

  it('gives every dynamic segment under a revalidate window a generateStaticParams', () => {
    // Without it Next treats the segment as fully dynamic and IGNORES
    // `revalidate`: the page renders per request with `private, no-store`, and
    // nothing at build time or in the logs says so. [locale] is covered by the
    // root layout's own generateStaticParams.
    for (const { file, source } of isr) {
      const segments = file.split(path.sep).filter((s) => /^\[.+\]$/.test(s) && s !== '[locale]');
      if (segments.length === 0) continue;
      expect(source, file).toMatch(/export (async )?function generateStaticParams\(/);
    }
  });

  it('keeps request-bound APIs out of the cached routes', () => {
    // A page that reads cookies or headers cannot be cached for everyone — and
    // one that starts doing so after it is cached fails at runtime instead.
    for (const { file, source } of isr) {
      expect(source, file).not.toMatch(/from ['"]next\/headers['"]/);
      expect(source, file).not.toMatch(/from ['"]@\/lib\/auth-session['"]/);
    }
  });

  it('keeps the ISR cache in memory, off the read-only app directory', () => {
    // On disk the entries are written into .next/server/app, which the image
    // leaves root-owned: each regeneration would log EACCES.
    expect(nextConfig.experimental?.isrFlushToDisk).toBe(false);
  });

  it('revalidates every cached page that shows partner content', () => {
    // A cached city or weekly page keeps whatever it rendered — the ad, its
    // «Реклама» label, the link to the advertiser — for the full hour. Hiding a
    // partner withdraws them everywhere at once, so every cached page that can
    // show one must be among the surfaces the partner and ad actions
    // revalidate, named by its ROUTE: `[locale]` included, since that is the
    // tag Next puts on the cached page.
    const showing = isr.filter(({ file, source }) =>
      PARTNER_CONTENT.test(withLocalImports(path.join(APP_DIR, file), source)),
    );
    // Not vacuous: the city page carries an ad slot and the headline strip.
    expect(showing.map(({ file }) => file.split(path.sep).join('/'))).toContain(
      '[locale]/igrishta/[city]/page.tsx',
    );
    for (const { file } of showing) {
      const route = `/${path.dirname(file).split(path.sep).join('/')}`;
      expect(PARTNER_SURFACES, file).toContain(route);
    }
    // And every surface named is a real page, so none can be a silent no-op.
    for (const surface of PARTNER_SURFACES) {
      expect(statSync(path.join(APP_DIR, surface, 'page.tsx')).isFile(), surface).toBe(true);
    }
  });

  it('has every partner and ad-placement action revalidate those surfaces', () => {
    // Not only the placement actions: a partner's visibility, window and tier
    // are half of what decides whether its ads and its headline logo render.
    for (const name of ['actions.ts', 'ad-actions.ts']) {
      const source = readFileSync(path.join(PARTNERS_ADMIN, name), 'utf8');
      const actions = source.split(/^export async function /m).slice(1);
      expect(actions.length, name).toBeGreaterThan(0);
      for (const body of actions) {
        const action = /^\w+/.exec(body)?.[0] ?? '?';
        expect(body, `${name}: ${action}`).toContain('revalidatePartnerSurfaces()');
      }
    }
  });
});

interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

describe('static asset cache headers', () => {
  async function headersFor(pathname: string): Promise<Map<string, string>> {
    const rules = ((await nextConfig.headers?.()) ?? []) as HeaderRule[];
    const out = new Map<string, string>();
    for (const rule of rules) {
      // The options Next's own router compiles custom header rules with.
      const match = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true });
      if (match(pathname) === false) continue;
      for (const { key, value } of rule.headers) out.set(key.toLowerCase(), value);
    }
    return out;
  }

  function maxAge(cacheControl: string | undefined): number {
    return Number(/max-age=(\d+)/.exec(cacheControl ?? '')?.[1] ?? 0);
  }

  it('lets browsers keep the map glyphs for a month', async () => {
    const glyph = await headersFor('/fonts/Noto%20Sans%20Regular/0-255.pbf');
    expect(maxAge(glyph.get('cache-control'))).toBeGreaterThanOrEqual(30 * 24 * 3600);
    // The real type, so Caddy's default `encode` matcher compresses them.
    expect(glyph.get('content-type')).toBe('application/x-protobuf');
  });

  it('labels only the glyph ranges as protobuf', async () => {
    const font = await headersFor('/fonts/og/golos-text-cyrillic-400-normal.woff');
    expect(font.get('content-type')).toBeUndefined();
    expect(maxAge(font.get('cache-control'))).toBeGreaterThan(0);
  });

  it('caches app icons for a day, with a background refresh', async () => {
    const icon = await headersFor('/icons/icon-192.png');
    expect(maxAge(icon.get('cache-control'))).toBe(86400);
    expect(icon.get('cache-control')).toContain('stale-while-revalidate');
  });

  it('leaves the service worker script and pages uncached', async () => {
    // A cached sw.js would keep a stale worker in charge of every visitor.
    expect((await headersFor('/sw.js')).get('cache-control')).toBeUndefined();
    expect((await headersFor('/igrishta/sofia')).get('cache-control')).toBeUndefined();
    // The security headers still apply to the assets.
    expect(
      (await headersFor('/fonts/Noto%20Sans%20Regular/0-255.pbf')).get('x-frame-options'),
    ).toBe('DENY');
  });
});

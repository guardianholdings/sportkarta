import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { viewFromPoints } from '../lib/geo';
import { buildAlternates, siteCardPath, siteSocialMetadata } from '../lib/seo';
import { STATIC_SITEMAP_PATHS } from '../lib/sitemap-static';
import { renderSitemapIndex, renderUrlset } from '../lib/sitemap-xml';

interface Alt {
  canonical: string;
  languages: Record<string, string>;
}

describe('buildAlternates', () => {
  it('bg page: self-canonical + full hreflang cluster', () => {
    const a = buildAlternates('/igrishta/varna', 'bg') as Alt;
    expect(a.canonical).toMatch(/\/igrishta\/varna$/);
    expect(a.languages.bg).toBe(a.canonical);
    expect(a.languages.en).toMatch(/\/en\/igrishta\/varna$/);
    expect(a.languages['x-default']).toBe(a.languages.bg);
  });

  it('en page canonicalizes to the /en URL', () => {
    const a = buildAlternates('/igrishta/varna', 'en') as Alt;
    expect(a.canonical).toMatch(/\/en\/igrishta\/varna$/);
    expect(a.languages['x-default']).toMatch(/\/igrishta\/varna$/);
  });

  it('handles the root path', () => {
    const a = buildAlternates('/', 'bg') as Alt;
    expect(a.languages.bg).toMatch(/\/$/);
    expect(a.languages.en).toMatch(/\/en$/);
  });
});

describe('sitemap XML', () => {
  it('renders a urlset with lastmod + hreflang alternates', () => {
    const xml = renderUrlset([{ path: '/igrishta/varna', lastmod: '2026-07-22T10:00:00Z' }]);
    expect(xml).toContain('<urlset');
    expect(xml).toContain('/igrishta/varna</loc>');
    expect(xml).toContain('<lastmod>2026-07-22</lastmod>');
    expect(xml).toContain('hreflang="bg"');
    expect(xml).toContain('hreflang="en"');
    expect(xml).toContain('hreflang="x-default"');
  });

  it('escapes XML special characters', () => {
    const xml = renderUrlset([{ path: '/a&b' }]);
    expect(xml).toContain('/a&amp;b');
    expect(xml).not.toMatch(/\/a&b[^a]/);
  });

  it('renders a sitemap index of child sitemaps', () => {
    const xml = renderSitemapIndex(['facilities.xml', 'places.xml', 'static.xml']);
    expect(xml).toContain('<sitemapindex');
    expect(xml).toContain('/sitemaps/facilities.xml</loc>');
    expect(xml).toContain('/sitemaps/static.xml</loc>');
  });
});

describe('static.xml', () => {
  const LOCALE = path.join(process.cwd(), 'app', '[locale]');
  /** The page file a locale-agnostic path is served by. */
  function pageFor(p: string): string {
    return p === '/'
      ? path.join(LOCALE, '(map)', 'page.tsx')
      : path.join(LOCALE, ...p.slice(1).split('/'), 'page.tsx');
  }

  it('lists the transparency and discovery pages, not only the four it started with', () => {
    for (const p of ['/statistika', '/danni', '/danni/litsenz', '/sesii', '/sedmitsata']) {
      expect(STATIC_SITEMAP_PATHS).toContain(p);
    }
  });

  it.each(STATIC_SITEMAP_PATHS)('%s is a real, canonical, indexable page', (p) => {
    const file = pageFor(p);
    expect(existsSync(file), `${p}: no page at ${file}`).toBe(true);
    const src = readFileSync(file, 'utf8');
    // A sitemap entry for a noindex page is a contradiction crawlers report.
    expect(src, `${p} is noindex`).not.toMatch(/index:\s*false/);
    expect(src, `${p} declares no canonical`).toContain(`buildAlternates('${p}'`);
  });

  it('keeps the internal component catalogue out', () => {
    expect(STATIC_SITEMAP_PATHS as readonly string[]).not.toContain('/design-system');
  });
});

describe('site-wide share metadata', () => {
  const labels = { siteName: 'POPS', imageAlt: 'POPS card' };

  it('gives every page a large-image card in its own locale', () => {
    const bgMeta = siteSocialMetadata('bg', labels);
    const og = bgMeta.openGraph as Record<string, unknown>;
    expect(og.siteName).toBe('POPS');
    expect(og.locale).toBe('bg_BG');
    expect(og.alternateLocale).toEqual(['en_GB']);
    expect(og.images).toEqual([
      { url: '/og/bg/site/card.png', width: 1200, height: 630, alt: 'POPS card' },
    ]);
    expect(bgMeta.twitter).toEqual({ card: 'summary_large_image' });
    expect((siteSocialMetadata('en', labels).openGraph as Record<string, unknown>).locale).toBe(
      'en_GB',
    );
  });

  it('sets no title or description, so each page previews under its own', () => {
    // Next fills og:title / og:description from the page's resolved metadata
    // only when they are ABSENT here; a layout-level title would stamp the
    // site name onto every shared link.
    const og = siteSocialMetadata('bg', labels).openGraph as Record<string, unknown>;
    expect(og).not.toHaveProperty('title');
    expect(og).not.toHaveProperty('description');
  });

  it('points at the site card route on disk', () => {
    expect(siteCardPath('en')).toBe('/og/en/site/card.png');
    expect(siteCardPath('xx')).toBe('/og/bg/site/card.png');
    const route = path.join(
      process.cwd(),
      'app',
      'og',
      '[locale]',
      'site',
      'card.png',
      'route.tsx',
    );
    expect(existsSync(route)).toBe(true);
  });
});

describe('viewFromPoints', () => {
  it('frames a spread of points within valid zoom bounds', () => {
    const v = viewFromPoints([
      { lon: 23, lat: 42 },
      { lon: 23.2, lat: 42.2 },
    ]);
    expect(v.lng).toBeCloseTo(23.1);
    expect(v.lat).toBeCloseTo(42.1);
    expect(v.zoom).toBeGreaterThanOrEqual(4);
    expect(v.zoom).toBeLessThanOrEqual(15);
  });

  it('returns a whole-Bulgaria overview for no points', () => {
    expect(viewFromPoints([]).zoom).toBeLessThan(8);
  });

  it('zooms in close on a single point', () => {
    expect(viewFromPoints([{ lon: 23.32, lat: 42.7 }]).zoom).toBe(14);
  });
});

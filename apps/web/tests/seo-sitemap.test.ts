import { describe, expect, it } from 'vitest';

import { viewFromPoints } from '../lib/geo';
import { buildAlternates } from '../lib/seo';
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

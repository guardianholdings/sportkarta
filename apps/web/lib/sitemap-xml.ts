import { siteUrl } from '@/lib/seo';

// Minimal, dependency-free sitemap XML rendering. Each <url> carries hreflang
// alternates (bg default + en + x-default) so both locale versions are
// discoverable from one entry. loc is the bg (canonical) URL.

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface UrlEntry {
  /** Locale-agnostic path, leading slash (e.g. /igrishta/varna). */
  path: string;
  /** Optional lastmod (ISO datetime or date); rendered as date. */
  lastmod?: string;
}

function urlBlock(entry: UrlEntry): string {
  const base = siteUrl();
  const rel = entry.path === '/' ? '' : entry.path;
  const bg = escapeXml(`${base}${rel || '/'}`);
  const en = escapeXml(`${base}/en${rel}`);
  const lastmod = entry.lastmod
    ? `\n    <lastmod>${escapeXml(entry.lastmod.slice(0, 10))}</lastmod>`
    : '';
  return `  <url>
    <loc>${bg}</loc>${lastmod}
    <xhtml:link rel="alternate" hreflang="bg" href="${bg}"/>
    <xhtml:link rel="alternate" hreflang="en" href="${en}"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${bg}"/>
  </url>`;
}

export function renderUrlset(entries: UrlEntry[]): string {
  const body = entries.map(urlBlock).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${body}
</urlset>`;
}

export function renderSitemapIndex(names: string[]): string {
  const base = siteUrl();
  const body = names
    .map(
      (name) =>
        `  <sitemap>\n    <loc>${escapeXml(`${base}/sitemaps/${name}`)}</loc>\n  </sitemap>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</sitemapindex>`;
}

export const XML_HEADERS = {
  'Content-Type': 'application/xml; charset=utf-8',
  'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
};

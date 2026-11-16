import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import robots from '../app/robots';
import { STATIC_SITEMAP_PATHS } from '../lib/sitemap-static';
import nextConfig from '../next.config';

/**
 * What a crawler is handed, pinned — because none of it shows in a browser.
 *
 * Measured on production, 2026-11-16: the front page and the map sent their
 * title, description, canonical and hreflang in <body> to every client Next
 * does not know as a bot (GPTBot among them); the statistics and open-data
 * pages arrived as hidden blocks a script moves into place; three pages shared
 * one description; and no page but the facility's described itself as data. A
 * person looking at any of those pages saw nothing wrong.
 */

const WEB_ROOT = process.cwd(); // vitest runs with cwd = apps/web
const APP = path.join(WEB_ROOT, 'app');
const LOCALE = path.join(APP, '[locale]');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Source with comments blanked, so prose about a tag is not the tag. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

const rel = (file: string) => path.relative(WEB_ROOT, file);
const page = (...segments: string[]) => path.join(LOCALE, ...segments, 'page.tsx');

describe('metadata is in <head> for every client', () => {
  const pattern = (nextConfig as { htmlLimitedBots?: RegExp }).htmlLimitedBots;

  it('is configured, and survives the next-intl wrapper', () => {
    expect(pattern).toBeInstanceOf(RegExp);
  });

  it.each([
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0)',
    'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    'curl/8.7.1',
  ])('matches %j', (userAgent) => {
    // No list of names: the next crawler is one nobody has heard of yet.
    // (A request with no User-Agent at all is outside this setting's reach —
    // Next skips the pattern when there is nothing to test; next.config.ts.)
    expect(pattern?.test(userAgent)).toBe(true);
  });
});

describe('robots.txt', () => {
  const rules = robots().rules;
  const rule = Array.isArray(rules) ? rules[0] : rules;

  it('keeps the admin panel and the internal API out', () => {
    expect(rule?.disallow).toEqual(expect.arrayContaining(['/admin', '/en/admin', '/api/']));
  });

  it('opens the published open-data API, and only that, under /api/', () => {
    const allowed = [rule?.allow].flat();
    expect(allowed).toContain('/api/opendata/');
    expect(allowed.filter((entry) => entry?.startsWith('/api/'))).toEqual(['/api/opendata/']);
  });

  it('keeps crawlers off the bulk dumps, which nothing rate-limits', () => {
    // Longest match wins (RFC 9309): this must be longer than the Allow above.
    const dumps = [rule?.disallow].flat().find((entry) => entry?.includes('/dumps'));
    expect(dumps).toMatch(/^\/api\/opendata\/v\d+\/dumps$/);
  });
});

describe('structured data', () => {
  it('is written by one component only', () => {
    // serializeJsonLd is what stops a facility or club name closing the
    // element early; a second, hand-rolled tag is where that gets forgotten.
    const writers = [APP, path.join(WEB_ROOT, 'components'), path.join(WEB_ROOT, 'lib')]
      .flatMap(walk)
      .filter((file) => /\.tsx?$/.test(file))
      .filter((file) => /['"]application\/ld\+json['"]/.test(code(file)))
      .map(rel);
    expect(writers).toEqual([path.join('components', 'seo', 'json-ld.tsx')]);
  });

  it.each([
    [page('(home)'), /<SiteIdentity\b/],
    [page('obekt', '[slug]'), /<JsonLd\b/],
    [page('igrishta', '[city]'), /<ListingData\b/],
    [page('igrishta', '[city]', '[segment]'), /<ListingData\b/],
    [page('danni'), /<JsonLd\b/],
    [page('za-klubove'), /<JsonLd\b/],
    [page('klub', '[slug]'), /<JsonLd\b/],
  ])('%s describes itself', (file, marker) => {
    expect(code(file), rel(file)).toMatch(marker);
  });
});

describe('each listed page describes itself', () => {
  // The front page carries the site's own description from the layout.
  const pages = STATIC_SITEMAP_PATHS.filter((entry) => entry !== '/');

  it.each(pages)('%s sets its own description', (entry) => {
    const file = page(...entry.split('/').filter(Boolean));
    expect(existsSync(file), rel(file)).toBe(true);
    expect(code(file), `${entry} would show the site-wide description`).toMatch(/\bdescription\b/);
  });
});

describe('the pages a crawler reads arrive whole', () => {
  // A loading.tsx wraps its page in Suspense: the server sends the loading
  // mark first and the content afterwards, in hidden blocks a script moves
  // into place. A crawler that runs no scripts gets the content hidden and out
  // of order. The front page and the document pages are read far more than
  // they are navigated to, so they trade the loading mark for plain, ordered
  // HTML (the front page by operator decision, 2026-11-16).
  it.each(['(home)', 'statistika', 'danni', 'privacy', 'partnyori', 'podkrepi'])(
    '/%s has no loading boundary',
    (segment) => {
      expect(existsSync(path.join(LOCALE, segment, 'loading.tsx'))).toBe(false);
    },
  );
});

describe('the static sitemap', () => {
  it('does not stamp unchanged pages as changed today', () => {
    const src = code(path.join(APP, 'sitemaps', '[name]', 'route.ts'));
    expect(src).not.toMatch(/new Date\(/);
  });
});

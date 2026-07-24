import { expect, type Page, test } from '@playwright/test';

import { ADMIN_EMAIL, signIn } from './auth';

/**
 * Per-role link crawler — the permanent regression against the audit's findings
 * (docs/design/{UX-AUDIT,COVERAGE-MATRIX,DEAD-CONTROLS}.md). It visits the
 * landing surfaces each role can reach, follows every internal link, and fails
 * on:
 *   - a page that 404s / 500s,
 *   - an internal link that resolves to 404 / 5xx (a dead link),
 *   - an `<a>` that navigates nowhere (empty / `#` / `javascript:`),
 *   - an `onclick` handler on a non-button/link element (the seed prototype's
 *     anti-pattern — the audit confirmed we don't inherit it; this keeps it so).
 *
 * `page.request` shares the browser context's cookies, so an admin link is
 * fetched with the admin session and must actually render (not redirect to
 * sign-in). Sofia is in every real import (see accountability.spec), so its
 * city-scoped routes are stable seed anchors; facility links are discovered from
 * the pages themselves rather than hard-coded.
 */

const CITY = 'sofia';

const PUBLIC_ROUTES = [
  '/',
  `/igrishta/${CITY}`,
  '/klasirane',
  '/kampanii',
  '/statistika',
  '/danni',
  '/danni/klyuchove',
  '/danni/litsenz',
  '/privacy',
  '/sesii',
  `/obshtina/${CITY}`,
  `/sedmitsata/${CITY}`,
  '/vhod',
];

const MEMBER_ROUTES = [...PUBLIC_ROUTES, '/profil', '/pasport', '/dobavi'];

const ADMIN_ROUTES = [
  ...MEMBER_ROUTES,
  '/admin',
  '/admin/facilities',
  '/admin/verify',
  '/admin/moderation',
  '/admin/sesii',
  '/admin/rezultati',
  '/admin/kampanii',
  '/admin/ambasadori',
  '/admin/otcheti',
  '/admin/obshtini',
  '/admin/import',
];

interface CrawlResult {
  badPages: string[];
  deadLinks: string[];
  emptyLinks: string[];
  antiPatterns: string[];
}

// Next runs on-demand compilation under `pnpm dev` (the e2e web server), so a
// cold route's first hit is slow and a burst of them can time out or briefly
// refuse a connection. That is a dev artifact, not a dead link — so every fetch
// retries transient failures and only a definitive HTTP status is trusted. The
// verdict a route earns is its STATUS; only 404/5xx (or persistent
// unreachability after every retry) counts against it.
async function statusOf(page: Page, url: string, nav: boolean): Promise<number | 'unreachable'> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (nav) {
        const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        return r?.status() ?? 0;
      }
      const r = await page.request.get(url, { maxRedirects: 5, timeout: 30_000 });
      return r.status();
    } catch {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); // back off; the route is likely compiling
    }
  }
  return 'unreachable';
}

async function crawl(page: Page, routes: string[]): Promise<CrawlResult> {
  const res: CrawlResult = { badPages: [], deadLinks: [], emptyLinks: [], antiPatterns: [] };
  const links = new Map<string, string>(); // internal target → first source route

  // 1. Visit each landing surface (sequential): assert it renders, collect links.
  for (const route of routes) {
    const status = await statusOf(page, route, true);
    if (status === 'unreachable' || status === 404 || status >= 500) {
      res.badPages.push(`${route} → ${String(status)}`);
      continue;
    }

    const stray = await page.$$eval('[onclick]', (els) =>
      els.filter((e) => e.tagName !== 'A' && e.tagName !== 'BUTTON').map((e) => e.tagName),
    );
    if (stray.length) res.antiPatterns.push(`${route}: onclick on ${stray.join(', ')}`);

    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href') ?? ''));
    for (const href of hrefs) {
      if (href === '' || href === '#' || href.startsWith('javascript:')) {
        res.emptyLinks.push(`${route}: "${href}"`);
        continue;
      }
      if (!href.startsWith('/') || href.startsWith('//')) continue; // internal only
      const target = href.split('#')[0] ?? '';
      if (target && !links.has(target)) links.set(target, route);
    }
  }

  // 2. Check every unique internal link once. Low concurrency so the dev server's
  //    on-demand compiler isn't overwhelmed into false timeouts.
  const entries = [...links.entries()];
  const CONCURRENCY = 4;
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ([target, src]) => {
        const status = await statusOf(page, target, false);
        return status === 'unreachable' || status === 404 || status >= 500
          ? `${src} → ${target} (${String(status)})`
          : null;
      }),
    );
    for (const bad of results) if (bad) res.deadLinks.push(bad);
  }
  return res;
}

function assertClean(res: CrawlResult): void {
  expect(res.badPages, 'landing pages that 404/500').toEqual([]);
  expect(res.deadLinks, 'internal links that 404/5xx').toEqual([]);
  expect(res.emptyLinks, 'links that navigate nowhere').toEqual([]);
  expect(res.antiPatterns, 'onclick on non-button/link elements').toEqual([]);
}

test.describe('link crawler', () => {
  test.describe.configure({ timeout: 180_000 });

  test('anonymous', async ({ page }) => {
    assertClean(await crawl(page, PUBLIC_ROUTES));
  });

  test('member', async ({ page }) => {
    await signIn(page, `crawl-member-${String(Date.now())}@example.org`, /\/profil/);
    assertClean(await crawl(page, MEMBER_ROUTES));
  });

  test('admin', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, /\/profil/);
    assertClean(await crawl(page, ADMIN_ROUTES));
  });
});

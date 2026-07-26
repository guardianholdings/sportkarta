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
  '/partnyori',
  '/podkrepi',
  '/sesii',
  `/obshtina/${CITY}`,
  `/sedmitsata/${CITY}`,
  '/vhod',
];

const MEMBER_ONLY = ['/profil', '/pasport', '/dobavi'];
const MEMBER_ROUTES = [...PUBLIC_ROUTES, ...MEMBER_ONLY];

const ADMIN_ONLY = [
  '/admin',
  '/admin/facilities',
  '/admin/verify',
  '/admin/moderation',
  '/admin/sesii',
  '/admin/rezultati',
  '/admin/kampanii',
  '/admin/partnyori',
  '/admin/ambasadori',
  '/admin/otcheti',
  '/admin/obshtini',
  '/admin/import',
];
const ADMIN_ROUTES = [...MEMBER_ROUTES, ...ADMIN_ONLY];

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

/**
 * Authorization probe: a role must NOT be able to reach a route above its
 * privilege. A protected route redirects the under-privileged caller to sign-in
 * (or 4xx), so "reached" = the final path is still the requested route with a
 * 2xx. Any leak fails — a control visible to a role that cannot use it is both a
 * UX and an authz bug.
 */
async function assertDenied(page: Page, routes: string[], label: string): Promise<void> {
  const leaks: string[] = [];
  for (const route of routes) {
    let status = 0;
    let finalPath = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await page.request.get(route, { maxRedirects: 5, timeout: 30_000 });
        status = r.status();
        finalPath = new URL(r.url()).pathname.replace(/^\/(bg|en)(?=\/|$)/, '') || '/';
        break;
      } catch {
        await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
      }
    }
    if (status >= 200 && status < 400 && finalPath === route) {
      leaks.push(`${route} (reached: ${String(status)})`);
    }
  }
  expect(leaks, `${label} must not reach protected routes`).toEqual([]);
}

test.describe('link crawler', () => {
  // Each crawl visits every route for a role; against `next dev` a cold full run
  // compiles them all on demand, which pushed this past 180 s. 240 s keeps the
  // heaviest role crawl inside its budget even when the server starts cold.
  test.describe.configure({ timeout: 240_000 });

  test('anonymous', async ({ page }) => {
    assertClean(await crawl(page, PUBLIC_ROUTES));
    // Auth-gating: an anonymous visitor reaches no member/admin surface.
    await assertDenied(page, [...MEMBER_ONLY, ...ADMIN_ONLY], 'anonymous');
  });

  test('member', async ({ page }) => {
    await signIn(page, `crawl-member-${String(Date.now())}@example.org`, /\/profil/);
    assertClean(await crawl(page, MEMBER_ROUTES));
    // A plain member reaches no admin/ambassador surface.
    await assertDenied(page, ADMIN_ONLY, 'member');
  });

  test('admin', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, /\/profil/);
    assertClean(await crawl(page, ADMIN_ROUTES));
  });
});

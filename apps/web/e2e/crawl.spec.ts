import { expect, type Page, test } from '@playwright/test';

import { ADMIN_EMAIL, signIn } from './auth';
import { rendersNotFound, softRedirectTarget } from './responses';

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
  '/sedmitsata',
  `/sedmitsata/${CITY}`,
  '/vhod',
];

const MEMBER_ONLY = ['/profil', '/pasport', '/dobavi', '/trenirovki'];
const MEMBER_ROUTES = [...PUBLIC_ROUTES, ...MEMBER_ONLY];

// Every screen in the admin nav (admin/(protected)/layout.tsx). Account
// management and the private-business list were missing, so nothing proved
// they render for an admin or stay hidden from everyone else; the per-account
// pages are reached through the links on /admin/akaunti, which step 2 of the
// crawl follows with the admin session.
const ADMIN_ONLY = [
  '/admin',
  '/admin/facilities',
  '/admin/verify',
  '/admin/moderation',
  '/admin/akaunti',
  '/admin/sesii',
  '/admin/rezultati',
  '/admin/kampanii',
  '/admin/partnyori',
  '/admin/ambasadori',
  '/admin/chastni',
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

// Locally the e2e server can be `next dev` (playwright.config.ts), which
// compiles each route on its first hit, so a burst of cold routes can time out
// or briefly refuse a connection. That is a dev artifact, not a dead link — so
// every fetch retries transient failures and only a definitive answer is
// trusted. A route's verdict is its status, with one correction: a page that
// rendered the not-found UI counts as the 404 it would have been, because
// behind the root loading boundary notFound() arrives with a 200 status line
// (e2e/responses.ts). Without that, a dead link could no longer fail the crawl.
async function statusOf(page: Page, url: string, nav: boolean): Promise<number | 'unreachable'> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (nav) {
        const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (!r) return 0;
        return rendersNotFound(r.status(), await r.text()) ? 404 : r.status();
      }
      const r = await page.request.get(url, { maxRedirects: 5, timeout: 30_000 });
      return rendersNotFound(r.status(), await r.text()) ? 404 : r.status();
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
 * privilege. A protected route answers an under-privileged caller in one of
 * four ways, all of them a denial:
 *   - the middleware redirects to sign-in (the final path is not the route),
 *   - a 4xx,
 *   - the page's own requireUser() redirects after the 200 shell has streamed
 *     (a meta-refresh to the sign-in page — /trenirovki does this, since the
 *     middleware does not list it),
 *   - the page's requireRole()/requireAdmin() renders the not-found UI behind a
 *     200 (every /admin screen for a signed-in member).
 * Anything else that comes back 2xx on the requested path is a leak. Reading
 * only the status line, as this did before the loading boundary landed,
 * reported the last two as leaks — 13 false alarms that hid any real one.
 */
async function assertDenied(page: Page, routes: string[], label: string): Promise<void> {
  const leaks: string[] = [];
  for (const route of routes) {
    let status = 0;
    let finalPath = '';
    let html = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await page.request.get(route, { maxRedirects: 5, timeout: 30_000 });
        status = r.status();
        finalPath = new URL(r.url()).pathname.replace(/^\/(bg|en)(?=\/|$)/, '') || '/';
        html = await r.text();
        break;
      } catch {
        await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
      }
    }
    if (status < 200 || status >= 400 || finalPath !== route) continue;
    if (rendersNotFound(status, html)) continue;
    const sentTo = softRedirectTarget(html);
    if (sentTo === '/vhod') continue;
    leaks.push(`${route} (reached: ${String(status)}${sentTo ? `, redirected to ${sentTo}` : ''})`);
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

  /**
   * REACHABILITY, which the crawl above does NOT test.
   *
   * `crawl` visits PUBLIC_ROUTES — a hardcoded array — so it stays green for a
   * page with zero inbound links. That is exactly how /kampanii came to be
   * BURIED (docs/design/COVERAGE-MATRIX.md:87): reachable by URL, linked from
   * nowhere, and no test noticed. `/sedmitsata` was the same, with its one link
   * behind requireUser() on /profil.
   *
   * This asserts the property the audit actually cares about: an ANONYMOUS
   * visitor can FIND these pages by following links. Delete the footer entry or
   * the /sesii card and this goes red — the crawl would not.
   *
   * Deliberately checks entry points that render UNCONDITIONALLY. A live
   * campaign strip would satisfy a weaker version of this test today and fail
   * silently the day the last campaign closes, re-burying the page on a delay.
   */
  test('buried surfaces are reachable by an anonymous visitor', async ({ page }) => {
    async function internalLinksOn(route: string): Promise<string[]> {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      const hrefs = await page.$$eval('a[href]', (as) =>
        as.map((a) => a.getAttribute('href') ?? ''),
      );
      return hrefs.map((h) => (h.split('#')[0] ?? '').replace(/^\/en(?=\/|$)/, ''));
    }

    // /sesii is where COVERAGE-MATRIX puts both entry points.
    const fromSesii = await internalLinksOn('/sesii');
    expect(fromSesii, '/kampanii must be linked from /sesii (COVERAGE-MATRIX §1)').toContain(
      '/kampanii',
    );
    expect(fromSesii, '/sedmitsata must be linked from /sesii (COVERAGE-MATRIX §3)').toContain(
      '/sedmitsata',
    );

    // …and the global footer keeps /kampanii reachable from every non-map page,
    // so it survives any single surface being redesigned.
    const fromLeaderboard = await internalLinksOn('/klasirane');
    expect(fromLeaderboard, '/kampanii must be in the global footer').toContain('/kampanii');

    // The index must actually lead somewhere: at least one city, or an explicit
    // empty state that offers the way on rather than a blank list.
    const fromWeekly = await internalLinksOn('/sedmitsata');
    const leadsOn = fromWeekly.some((h) => h.startsWith('/sedmitsata/') || h === '/sesii');
    expect(leadsOn, '/sedmitsata must link to a city page or offer a way on').toBe(true);
  });

  test('member', async ({ page }) => {
    await signIn(page, `crawl-member-${String(Date.now())}@example.org`, /\/profil/);
    assertClean(await crawl(page, MEMBER_ROUTES));
    // A plain member reaches no admin/ambassador surface.
    await assertDenied(page, ADMIN_ONLY, 'member');
  });

  /**
   * The member-side counterpart of the anonymous reachability test above.
   *
   * /trenirovki has no nav tab — the bar is already four items plus the add FAB
   * — so it is reachable only by the links this asserts. Crawling it in
   * MEMBER_ROUTES proves it RENDERS; this proves a member can FIND it, which is
   * the distinction A6 was written about after /kampanii sat link-less behind a
   * green crawl.
   */
  test('a member can find their training log', async ({ page }) => {
    await signIn(page, `crawl-training-${String(Date.now())}@example.org`, /\/profil/);

    const linksOn = async (route: string): Promise<string[]> => {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      const hrefs = await page.$$eval('a[href]', (as) =>
        as.map((a) => a.getAttribute('href') ?? ''),
      );
      return hrefs.map((h) => (h.split('#')[0] ?? '').replace(/^\/en(?=\/|$)/, ''));
    };

    expect(await linksOn('/profil'), '/trenirovki must be linked from /profil').toContain(
      '/trenirovki',
    );
    expect(
      await linksOn('/klasirane'),
      '/trenirovki must be linked from the participation board',
    ).toContain('/trenirovki');
  });

  test('admin', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, /\/profil/);
    assertClean(await crawl(page, ADMIN_ROUTES));
  });
});

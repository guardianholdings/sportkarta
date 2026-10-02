import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Where the app's special route files may live — asserted, because every
 * mistake here is silent.
 *
 * A `loading.tsx` wraps its segment in Suspense, and Next sends the status line
 * with the first streamed byte. So a notFound() anywhere below a loading file
 * still answers HTTP 200 (a "soft 404"): no crawler, uptime monitor or the e2e
 * link crawler can tell a removed facility from a live one. That is exactly
 * what a single app/[locale]/loading.tsx did to every facility, session,
 * campaign, passport, city and admin URL until the pre-launch audit. Nothing
 * about it shows in a screenshot — the page looks identical either way.
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

/** Source with comments blanked, so prose ABOUT notFound() is not a call. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

const rel = (file: string) => path.relative(WEB_ROOT, file);

const LOADING_FILES = walk(LOCALE).filter((f) => path.basename(f) === 'loading.tsx');

describe('loading boundaries never sit above a notFound()', () => {
  it('there is no loading.tsx at the root of the locale segment', () => {
    expect(existsSync(path.join(LOCALE, 'loading.tsx'))).toBe(false);
  });

  it('the rest of the app still has its loading screens', () => {
    // The fix was to MOVE the boundary down, not to delete the brand moment.
    expect(LOADING_FILES.length).toBeGreaterThan(5);
    expect(existsSync(path.join(LOCALE, '(map)', 'loading.tsx')), 'the map / home page').toBe(true);
  });

  it.each(LOADING_FILES.map(rel))('%s wraps no route that can 404', (loading) => {
    const segment = path.dirname(path.join(WEB_ROOT, loading));
    // requireRole/requireAdmin 404 an under-ranked account (lib/auth-session.ts),
    // so a page that calls them can 404 as surely as one calling notFound().
    const offenders = walk(segment)
      .filter((f) => /\/(page|layout)\.tsx$/.test(f))
      .filter((f) => /\b(notFound|requireRole|requireAdmin)\s*\(/.test(code(f)))
      .map(rel);
    expect(
      offenders,
      `${loading} streams a 200 before these can call notFound() — move the loading file below them, or drop it`,
    ).toEqual([]);
  });
});

describe('not-found and error boundaries exist where they must', () => {
  it('a localized not-found renders inside the locale layout', () => {
    const src = code(path.join(LOCALE, 'not-found.tsx'));
    expect(src).toContain("getTranslations('NotFound')");
    expect(src).toContain('<AppShell');
  });

  it('an unmatched localized path is routed into it by a catch-all', () => {
    const src = code(path.join(LOCALE, '[...rest]', 'page.tsx'));
    expect(src).toMatch(/\bnotFound\(\)/);
  });

  it('the locale error boundary is a client component with a retry', () => {
    const src = readFileSync(path.join(LOCALE, 'error.tsx'), 'utf8');
    expect(src.startsWith("'use client';")).toBe(true);
    expect(src).toContain("useTranslations('ErrorPage')");
    expect(src).toContain('reset()');
  });

  it('the root boundaries render their own document above a pass-through root layout', () => {
    // app/layout.tsx must not render <html>: [locale]/layout.tsx does, with the
    // locale's lang. The two root boundaries sit above that layout and so must.
    expect(code(path.join(APP, 'layout.tsx'))).not.toContain('<html');
    for (const file of ['not-found.tsx', 'global-error.tsx']) {
      const src = code(path.join(APP, file));
      expect(src, file).toMatch(/<html lang=\{/);
      expect(src, file).toContain('<body');
    }
    expect(
      readFileSync(path.join(APP, 'global-error.tsx'), 'utf8').startsWith("'use client';"),
    ).toBe(true);
  });

  it('global-error ships one namespace of the catalogues, not both whole', () => {
    // It is the root error boundary, so its chunk loads on EVERY page. Reading
    // only `bg.ErrorPage` / `en.ErrorPage` lets the bundler drop the rest of the
    // ~250 KB of JSON; `messages: bg` would quietly ship all of it.
    const src = code(path.join(APP, 'global-error.tsx'));
    const reads = [...src.matchAll(/\b(?:bg|en)\.(\w+)/g)]
      .map((m) => m[1])
      .filter((key) => key !== 'json');
    expect(new Set(reads)).toEqual(new Set(['ErrorPage']));
    expect(src).not.toMatch(/messages:\s*(?:bg|en)\b/);
  });

  it('both error boundaries forward what they catch to monitoring', () => {
    for (const file of [path.join(LOCALE, 'error.tsx'), path.join(APP, 'global-error.tsx')]) {
      expect(code(file), rel(file)).toContain('reportCaughtError(error)');
    }
  });
});

describe('internal pages are not public in production', () => {
  it.each(['design-system/layout.tsx', 'dev/poshta/page.tsx'])('%s 404s in production', (file) => {
    expect(code(path.join(LOCALE, file))).toMatch(
      /if \(process\.env\.NODE_ENV === 'production'\) notFound\(\);/,
    );
  });
});

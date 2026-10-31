import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * AppShell reads the session cookie to label the last tab «Вход» or «Профил»
 * (components/shell/app-shell.tsx). That read is a request API: on a page
 * meant to be cached — an ISR listing, a static page — it would silently turn
 * every visit into a fresh render. Those pages pass `cached`; this finds every
 * page that renders the shell WITHOUT any request-time API of its own and
 * requires the flag, so a new static page cannot forget it.
 */

const APP = path.join(__dirname, '..', 'app', '[locale]');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.tsx$/.test(name) ? [full] : [];
  });
}

/** A route already rendered per request: the cookie read costs it nothing. */
const DYNAMIC =
  /export const dynamic = 'force-dynamic'|getCurrentUser\(|requireUser\(|requireClub\w*\(|headers\(\)|cookies\(\)/;

describe('AppShell on a cached page', () => {
  const shells = walk(APP).filter((f) => /<AppShell[\s>]/.test(readFileSync(f, 'utf8')));

  it('finds the shell pages', () => {
    expect(shells.length).toBeGreaterThan(30);
  });

  it('passes `cached` wherever the page itself reads nothing from the request', () => {
    const missing = shells.filter((file) => {
      const src = readFileSync(file, 'utf8');
      const isrOrStatic = /export const revalidate/.test(src) || !DYNAMIC.test(src);
      return isrOrStatic && /<AppShell(?![^>]*\bcached\b)[^>]*>/.test(src);
    });
    expect(missing.map((f) => path.relative(APP, f))).toEqual([]);
  });

  it('knows the cached pages by name', () => {
    const cached = shells
      .filter((f) => /<AppShell[^>]*\bcached\b/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(APP, f))
      .sort();
    expect(cached).toEqual([
      'danni/litsenz/page.tsx',
      'igrishta/[city]/[segment]/page.tsx',
      'igrishta/[city]/page.tsx',
      'igrishta/list-page.tsx',
      'not-found.tsx',
      'sedmitsata/[city]/page.tsx',
    ]);
  });
});

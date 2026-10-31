import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { clubPageCsp, isClubPublicPage } from '../lib/club-page-csp';

const APP = path.join(process.cwd(), 'app');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('the club page script policy (wave H2)', () => {
  it.each([
    '/klub/zala-sila',
    '/en/klub/zala-sila',
    '/klub/zala-sila/',
    '/klub/zala-sila/zapitvane',
    '/klub/zala-sila/sabitie/6f1c2d3e-0000-4000-8000-000000000000',
    '/en/klub/zala-sila/trenirovka/6f1c2d3e-0000-4000-8000-000000000000',
  ])('covers the public page %s', (path) => {
    expect(isClubPublicPage(path)).toBe(true);
  });

  it.each([
    '/klub/zala-sila/tablo',
    '/klub/zala-sila/az',
    '/klub/zala-sila/kiosk',
    '/klub/zala-sila/kupi/plan',
    '/klub/zala-sila/integratsii',
    '/klubove',
    '/karta',
    '/klub/zala-sila/sabitie/x/y',
  ])('leaves %s alone (the office, the portal, everything else)', (path) => {
    expect(isClubPublicPage(path)).toBe(false);
  });

  it('allows scripts from this site, the two vendors and the site analytics only', () => {
    const policy = clubPageCsp({ dev: false, analyticsSrc: 'https://umami.example.org/script.js' });
    const scripts = /script-src ([^;]+)/.exec(policy)?.[1]?.split(' ') ?? [];
    expect(scripts.sort()).toEqual(
      [
        "'self'",
        "'unsafe-inline'",
        'https://connect.facebook.net',
        'https://umami.example.org',
        'https://www.googletagmanager.com',
      ].sort(),
    );
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toMatch(/connect-src|img-src|default-src/);
  });

  it('lets the dev server evaluate, and ignores an analytics source that is not a URL', () => {
    const policy = clubPageCsp({ dev: true, analyticsSrc: 'not a url' });
    expect(policy).toContain("'unsafe-eval'");
    expect(policy).not.toContain('not a url');
  });

  it('is the policy of every page that renders club pixels, and only those pages do', () => {
    const rendering = walk(APP)
      .filter((file) => readFileSync(file, 'utf8').includes('<ClubTrackingSlot'))
      .map((file) => path.relative(APP, file).split(path.sep).join('/'))
      .sort();
    expect(rendering).toEqual([
      '[locale]/klub/[slug]/page.tsx',
      '[locale]/klub/[slug]/sabitie/[eventId]/page.tsx',
      '[locale]/klub/[slug]/trenirovka/[occurrenceId]/page.tsx',
      '[locale]/klub/[slug]/zapitvane/page.tsx',
    ]);
    for (const file of rendering) {
      const route = `/${file.replace('[locale]/', '').replace(/\/page\.tsx$/, '')}`
        .replace('[slug]', 'zala-sila')
        .replace(/\[(eventId|occurrenceId)\]/, '6f1c2d3e-0000-4000-8000-000000000000');
      expect(isClubPublicPage(route), route).toBe(true);
    }
  });

  it('keeps pixels off the class and event pages for a signed-in visitor', () => {
    // Signed in, those pages show names — the viewer's own and their family's.
    for (const file of [
      '[locale]/klub/[slug]/sabitie/[eventId]/page.tsx',
      '[locale]/klub/[slug]/trenirovka/[occurrenceId]/page.tsx',
    ]) {
      const source = readFileSync(path.join(APP, file), 'utf8');
      expect(source, file).toMatch(/\{!user && \(\s*<ClubTrackingSlot/);
    }
  });
});

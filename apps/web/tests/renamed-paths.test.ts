import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import { describe, expect, it } from 'vitest';

import nextConfig, { RENAMED_PATHS } from '../next.config';

/**
 * «Тренировки» became «Игри» (operator, 2026-10-31) and /sesii, /sesiya with
 * them. Every old address is a permanent redirect to the new one — links in
 * sent e-mails, subscribed calendars, shares and search results still land —
 * and every new address is a route that exists.
 */

const APP_DIR = path.join(process.cwd(), 'app'); // vitest runs with cwd = apps/web

/** The route folder an address lives in: `/igra` → app/[locale]/igra. */
function routeDir(address: string, localised: boolean): string {
  const segments = address
    .split('/')
    .filter(Boolean)
    .map((s) => (s === ':locale' ? '[locale]' : s));
  const admin = segments[0] === 'admin' ? ['admin', '(protected)', ...segments.slice(1)] : segments;
  return path.join(APP_DIR, ...(localised ? ['[locale]', ...admin] : admin));
}

/** Where a request for `pathname` is sent, or null when no redirect matches. */
async function redirectFor(pathname: string): Promise<string | null> {
  const rules = (await nextConfig.redirects?.()) ?? [];
  for (const rule of rules) {
    const params = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true })(pathname);
    if (params === false) continue;
    expect(rule.permanent).toBe(true);
    return rule.destination
      .replace(/:(\w+)\*/g, (_, name: string) => {
        const value = params[name];
        return Array.isArray(value) ? value.join('/') : String(value ?? '');
      })
      .replace(/:(\w+)/g, (_, name: string) => String(params[name]))
      .replace(/\/$/, '');
  }
  return null;
}

describe('the renamed addresses', () => {
  it.each(RENAMED_PATHS.filter(({ from }) => !from.startsWith('/og/')))(
    '$to exists and $from is gone',
    ({ from, to, localised }) => {
      expect(existsSync(routeDir(to, localised))).toBe(true);
      expect(existsSync(routeDir(from, localised))).toBe(false);
    },
  );

  it('draws the share card of a game under /og/<locale>/igra', () => {
    // One dynamic [kind] route draws every card, so the kind is a closed list.
    const card = readFileSync(
      path.join(APP_DIR, 'og', '[locale]', '[kind]', '[slug]', 'card.png', 'route.tsx'),
      'utf8',
    );
    expect(card).toContain("const KINDS = ['obekt', 'igra', 'kampaniya'] as const;");
  });

  it.each([
    ['/sesii', '/igri'],
    ['/en/sesii', '/en/igri'],
    ['/sesiya/5f0c', '/igra/5f0c'],
    ['/en/sesiya/5f0c/roster', '/en/igra/5f0c/roster'],
    ['/admin/sesii', '/admin/igri'],
    ['/kalendar/sesiya/futbol-5f0c.ics', '/kalendar/igra/futbol-5f0c.ics'],
    ['/og/bg/sesiya/5f0c/card.png', '/og/bg/igra/5f0c/card.png'],
  ])('sends %s to %s', async (from, to) => {
    expect(await redirectFor(from)).toBe(to);
  });

  it('leaves the training log and the new pages alone', async () => {
    for (const pathname of ['/trenirovki', '/igri', '/igra/5f0c', '/en/igri', '/sesiite']) {
      expect(await redirectFor(pathname)).toBeNull();
    }
  });
});

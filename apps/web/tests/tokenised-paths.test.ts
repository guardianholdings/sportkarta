import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TOKEN_PLACEHOLDER, scrubTokenisedPath } from '@/lib/tokenised-paths';

const APP = join(__dirname, '..', 'app');
const TOKEN = 'abcdef0123456789abcdef0123456789abcdef01';

/** Every route directory whose last segment is `[token]` or `[handle]`. */
function tokenRoutes(dir = APP, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    const here = `${prefix}/${entry}`;
    if (entry === '[token]' || entry === '[handle]') out.push(here);
    out.push(...tokenRoutes(full, here));
  }
  return out;
}

/** A concrete address for a route directory, the way a browser would see it. */
function sample(route: string, locale: '' | 'en'): string {
  return route
    .split('/')
    .filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment))
    .map((segment) => {
      if (segment === '[locale]') return locale;
      if (segment === '[token]') return TOKEN;
      if (segment === '[handle]') return 'ivan-petrov';
      if (segment.startsWith('[')) return 'x';
      return segment;
    })
    .filter((segment) => segment !== '')
    .map((segment) => `/${segment}`)
    .join('');
}

describe('tokenised paths', () => {
  const routes = tokenRoutes();

  it('finds the token routes', () => {
    expect(routes.length).toBeGreaterThanOrEqual(10);
  });

  it.each(routes)('covers %s in both locales', (route) => {
    for (const locale of ['', 'en'] as const) {
      // /og/lichen/[locale]/… carries the locale as a real segment ("bg").
      const address = sample(route, locale).replace('/og/lichen/pasport', '/og/lichen/bg/pasport');
      const scrubbed = scrubTokenisedPath(address);
      expect(scrubbed, address).toContain(TOKEN_PLACEHOLDER);
      expect(scrubbed).not.toContain(TOKEN);
      expect(scrubbed).not.toContain('ivan-petrov');
    }
  });

  it('leaves ordinary pages alone', () => {
    for (const path of [
      '/',
      '/karta',
      '/statistika',
      '/sedmitsata/sofia',
      '/obekt/way-123',
      '/igrishta/sofia/football',
      '/klubove/zayavka',
      '/klub/tvoyata-zala',
      '/klub/tvoyata-zala/az',
      '/kalendar/igra/x.ics',
      '/kalendar/klub-sabitie/x.ics',
      '/en/karta',
      '/pasport',
    ]) {
      expect(scrubTokenisedPath(path)).toBe(path);
    }
  });

  it('works on absolute addresses and keeps the rest of the path', () => {
    expect(scrubTokenisedPath(`https://pops.bg/klubove/pokana/${TOKEN}`)).toBe(
      'https://pops.bg/klubove/pokana/[token]',
    );
    expect(scrubTokenisedPath(`https://pops.bg/en/klub/zala/skan/${TOKEN}`)).toBe(
      'https://pops.bg/en/klub/zala/skan/[token]',
    );
  });
});

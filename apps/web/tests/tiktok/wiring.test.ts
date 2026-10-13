import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import nextConfig from '../../next.config';

const WEB = join(__dirname, '../..');
const ROOT = join(WEB, '../..');
const read = (path: string) => readFileSync(path, 'utf8');

/**
 * The middleware's matcher, read from its source: importing middleware.ts
 * pulls in next-intl's edge middleware, which does not load under vitest.
 */
function middlewareMatcher(): RegExp {
  const source = read(join(WEB, 'middleware.ts'));
  const literal = /matcher: '([^']+)'/.exec(source)?.[1];
  if (!literal) throw new Error('middleware.ts: matcher not found');
  // Next applies it to the whole pathname.
  return new RegExp(`^${literal.replaceAll('\\\\', '\\')}$`);
}

describe('the /tiktok demo sits outside the locale middleware', () => {
  const matcher = middlewareMatcher();

  it.each(['/tiktok', '/tiktok/', '/tiktok/publish', '/tiktok/status', '/auth/tiktok/callback'])(
    '%s is not rewritten into a locale (and its 50 MB post is not buffered by the middleware)',
    (path) => {
      expect(matcher.test(path)).toBe(false);
    },
  );

  it.each(['/', '/karta', '/en/karta', '/tiktokers', '/obekt/tiktok', '/auth', '/vhod'])(
    '%s still goes through the middleware',
    (path) => {
      expect(matcher.test(path)).toBe(true);
    },
  );
});

describe('the /tiktok demo is not indexed', () => {
  it('sends X-Robots-Tag: noindex on every /tiktok and /auth/tiktok URL', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    for (const source of ['/tiktok/:path*', '/auth/tiktok/:path*']) {
      const rule = rules.find((r) => r.source === source);
      expect(rule?.headers).toContainEqual({ key: 'X-Robots-Tag', value: 'noindex, nofollow' });
    }
  });

  it('is not in the sitemaps', () => {
    for (const file of ['app/sitemap.xml/route.ts', 'app/sitemaps/[name]/route.ts', 'lib/seo.ts']) {
      expect(read(join(WEB, file))).not.toMatch(/tiktok/i);
    }
  });

  it('its document carries no analytics and says noindex', () => {
    const layout = read(join(WEB, 'app/tiktok/layout.tsx'));
    expect(layout).toMatch(/robots: \{ index: false, follow: false \}/);
    expect(layout).not.toMatch(/^import .*(umami|analytics|gtag|zaraz)/im);
    expect(layout).not.toMatch(/<script|<Script/);
  });
});

describe('the browser form ships no server code', () => {
  it('imports only the client-safe constants from lib/tiktok', () => {
    const form = read(join(WEB, 'app/tiktok/post-form.tsx'));
    expect(form.startsWith("'use client';")).toBe(true);
    const imports = [...form.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    for (const source of imports) {
      if (source?.includes('lib/tiktok')) expect(source).toBe('@/lib/tiktok/shared');
    }
  });

  it('the shared module needs nothing from the server', () => {
    const shared = read(join(WEB, 'lib/tiktok/shared.ts'));
    expect(shared).not.toMatch(/^import /m);
    expect(shared).not.toMatch(/process\.env/);
  });
});

describe('deployment wiring', () => {
  it('the deploy passes the flag (off by default) and both credentials by name', () => {
    const deploy = read(join(ROOT, '.github/workflows/deploy.yml'));
    expect(deploy).toContain("TIKTOK_DEMO_ENABLED=${{ vars.TIKTOK_DEMO_ENABLED || 'false' }}");
    expect(deploy).toContain('TIKTOK_CLIENT_KEY=${{ secrets.TIKTOK_CLIENT_KEY }}');
    expect(deploy).toContain('TIKTOK_CLIENT_SECRET=${{ secrets.TIKTOK_CLIENT_SECRET }}');
  });

  it('compose hands them to the web container only, the flag off by default', () => {
    const compose = read(join(ROOT, 'deploy/compose.prod.yml'));
    expect(compose).toContain('TIKTOK_DEMO_ENABLED: ${TIKTOK_DEMO_ENABLED:-false}');
    expect(compose.match(/^\s+TIKTOK_CLIENT_SECRET:/gm)).toHaveLength(1);
    const web = compose.indexOf('\n  web:');
    const worker = compose.indexOf('\n  worker:');
    const secret = compose.search(/^\s+TIKTOK_CLIENT_SECRET:/m);
    expect(web).toBeGreaterThan(-1);
    expect(secret).toBeGreaterThan(web);
    if (worker > web) expect(secret).toBeLessThan(worker);
  });

  it('.env.example documents the flag off and leaves the credentials blank', () => {
    const example = read(join(ROOT, '.env.example'));
    expect(example).toMatch(/^TIKTOK_DEMO_ENABLED=false$/m);
    expect(example).toMatch(/^# TIKTOK_CLIENT_KEY=$/m);
    expect(example).toMatch(/^# TIKTOK_CLIENT_SECRET=$/m);
    expect(example).toContain('https://pops.bg/auth/tiktok/callback');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PERSON_SCOPED_KINDS, SHARE_KINDS, storyPath } from '@sportkarta/lib/share';
import { describe, expect, it } from 'vitest';

/**
 * The rules that make a person-scoped share safe, asserted against the ROUTES
 * rather than trusted to review.
 *
 * Each of these is a silent failure. A missing `no-store` produces a perfectly
 * working share whose named image a CDN then holds for a year — the frozen named
 * artifact migration 0012 forbids, and which an erased member cannot revoke. A
 * missing session check produces a URL that renders somebody's numbers to anyone
 * who guesses it. Neither shows up in a screenshot, so neither can be caught by
 * looking at the feature.
 */

const WEB = process.cwd();

const PERSON_ROUTES = [
  'app/og/lichen/[locale]/[kind]/story.png/route.tsx',
  'app/og/lichen/[locale]/[kind]/[ref]/story.png/route.tsx',
];

const PUBLIC_ROUTES = [
  'app/og/[locale]/story/[kind]/[slug]/story.png/route.tsx',
  'app/og/[locale]/[kind]/[slug]/card.png/route.tsx',
];

/**
 * Source with COMMENTS STRIPPED.
 *
 * The first version scanned raw text and went red on the public card route —
 * which mentions `no-store` only to explain why the person-scoped route needs
 * it. A gate that cannot tell code from prose fails on correct files and, worse,
 * would pass on a rule that had been written down instead of implemented.
 */
function source(relative: string): string {
  return readFileSync(join(WEB, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

describe('person-scoped share routes', () => {
  it.each(PERSON_ROUTES)('%s is never cached, stored or indexed', (route) => {
    const code = source(route);
    expect(code).toContain("export const dynamic = 'force-dynamic'");
    expect(code).toContain('private, no-store');
    expect(code).toContain('X-Robots-Tag');
    expect(code).toContain('noindex');
  });

  /**
   * THE SUBJECT IS THE SESSION, NEVER A PARAMETER. A story names the member, so
   * the only acceptable answer to "whose story is this" is `getCurrentUser()`.
   * A handle or an account id in the params would make it renderable for anyone.
   */
  it.each(PERSON_ROUTES)('%s resolves its subject from the session', (route) => {
    const code = source(route);
    expect(code).toContain('getCurrentUser()');
    // The params it accepts carry a locale, a kind and at most an opaque ref —
    // never a handle or a user id.
    expect(code).not.toMatch(/params[^)]*handle/);
    expect(code).not.toMatch(/params[^)]*userId/);
  });

  it.each(PERSON_ROUTES)('%s 404s an unauthenticated request', (route) => {
    const code = source(route);
    expect(code).toMatch(/if \(!user\) return new Response\('Not found', \{ status: 404/);
  });
});

describe('public share routes', () => {
  /**
   * The mirror image: a public card must NOT be no-store, because a link
   * preview that cannot be cached is refetched by every scraper on every paste.
   */
  it.each(PUBLIC_ROUTES)('%s does not opt out of caching', (route) => {
    const code = source(route);
    expect(code).not.toContain('no-store');
  });

  it.each(PUBLIC_ROUTES)('%s names no member', (route) => {
    const code = source(route);
    expect(code).not.toContain('getCurrentUser');
    expect(code).not.toContain('leaderboard_eligible_members');
  });
});

describe('the story path contract matches the routes on disk', () => {
  /**
   * `storyPath` is what the UI fetches; the route files are what answers. A
   * mismatch is a 404 on a share button, which is exactly the kind of thing that
   * only shows up when somebody tries to post.
   */
  it('puts every person-scoped kind under /og/lichen and the rest under /og', () => {
    for (const kind of SHARE_KINDS) {
      const path = storyPath({ kind, locale: 'bg', ref: 'ref' });
      expect(path, kind).not.toBeNull();
      const personScoped = (PERSON_SCOPED_KINDS as readonly string[]).includes(kind);
      expect(path?.startsWith('/og/lichen/'), kind).toBe(personScoped);
    }
  });

  it('serves every kind the UI can ask for', () => {
    // The three no-ref personal kinds live in the [kind] route…
    const noRef = source(PERSON_ROUTES[0] ?? '');
    for (const kind of ['week', 'passport', 'division']) {
      expect(noRef, kind).toContain(`'${kind}'`);
    }
    // …the ref-bearing one in the [kind]/[ref] route…
    expect(source(PERSON_ROUTES[1] ?? '')).toContain("'training'");
    // …and the public kinds in the public story route.
    const pub = source(PUBLIC_ROUTES[0] ?? '');
    for (const kind of ['facility', 'session', 'campaign', 'legend']) {
      expect(pub, kind).toContain(`'${kind}'`);
    }
  });

  /**
   * Both are load-bearing and both fail silently. The dot makes middleware skip
   * the path (otherwise every fetch 307s through the locale rewrite); the locale
   * segment exists BECAUSE of that dot, since next-intl then never resolves a
   * request locale and every story would render in Bulgarian.
   */
  it('keeps the dotted final segment and the locale segment on every story path', () => {
    for (const kind of SHARE_KINDS) {
      for (const locale of ['bg', 'en']) {
        const path = storyPath({ kind, locale, ref: 'ref' }) ?? '';
        expect(path.endsWith('/story.png'), `${kind}/${locale}`).toBe(true);
        expect(path.split('/').includes(locale), `${kind}/${locale}`).toBe(true);
      }
    }
  });
});

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { rendersNotFound, softRedirectTarget } from '../e2e/responses';

/**
 * The e2e suite's reading of a streamed denial (e2e/responses.ts), pinned in
 * the unit suite so it cannot quietly go vacuous.
 *
 * If a Next upgrade renamed the markers, the crawl would stop recognising
 * soft-404 dead links (silently) and the role probes would report every
 * denial as a leak (loudly, but for the wrong reason). The first block reads
 * the installed Next's own source for them; the rest are the HTML shapes
 * `next start` actually served for this app, captured on 2026-09-30.
 */

describe('the markers the e2e suite relies on', () => {
  it('are still what the installed Next writes into a streamed response', () => {
    const require = createRequire(import.meta.url);
    const next = path.dirname(require.resolve('next/package.json'));
    const source = readFileSync(
      path.join(next, 'dist/server/app-render/make-get-server-inserted-html.js'),
      'utf8',
    );
    expect(source).toMatch(/name:\s*"robots",\s*content:\s*"noindex"/);
    expect(source).toMatch(/id:\s*"__next-page-redirect",\s*httpEquiv:\s*"refresh"/);
  });
});

describe('rendersNotFound', () => {
  it('recognises notFound() behind a streamed 200', () => {
    const html =
      '<head><meta name="robots" content="noindex, nofollow"/></head>' +
      '<body><meta name="robots" content="noindex"/><h1>404</h1></body>';
    expect(rendersNotFound(200, html)).toBe(true);
  });

  it('recognises a real 404 whatever its body', () => {
    expect(rendersNotFound(404, '<p>Няма такава страница</p>')).toBe(true);
  });

  it('does not mistake a page that merely opts out of indexing', () => {
    const html = '<head><meta name="robots" content="noindex, nofollow"/></head><main>ok</main>';
    expect(rendersNotFound(200, html)).toBe(false);
    expect(rendersNotFound(200, '<meta name="robots" content="noindex, follow"/>')).toBe(false);
  });
});

describe('softRedirectTarget', () => {
  it('reads where redirect() sent the visitor after the shell streamed', () => {
    expect(
      softRedirectTarget(
        '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/vhod"/>',
      ),
    ).toBe('/vhod');
  });

  it('drops the locale prefix and the query string', () => {
    expect(
      softRedirectTarget(
        '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/en/vhod?next=%2Ftrenirovki&amp;x=1"/>',
      ),
    ).toBe('/vhod');
  });

  it('is null for a page that rendered', () => {
    expect(softRedirectTarget('<meta http-equiv="refresh" content="30"/><main>ok</main>')).toBe(
      null,
    );
  });
});

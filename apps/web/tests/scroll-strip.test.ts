import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * One horizontal strip (components/ui/scroll-strip.tsx) for every row of
 * tabs, hubs, section pills and filter chips (UX audit 2026-10-31, V-27 and
 * V-31). The vitest environment has no DOM, so the contract is held at the
 * source: the primitive scrolls, hides its track, fades and centres by its
 * own scrollLeft; and no page keeps a hand-rolled copy of the row.
 */
const WEB = path.join(__dirname, '..');
// Comments blanked: the primitive's own note names the API it avoids.
const strip = readFileSync(path.join(WEB, 'components', 'ui', 'scroll-strip.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.tsx$/.test(name) ? [full] : [];
  });
}

describe('ScrollStrip', () => {
  it('scrolls sideways without a track, fades its right edge and centres the active item', () => {
    expect(strip).toMatch(/overflow-x-auto/);
    expect(strip).toMatch(/scrollbar-none/);
    expect(strip).toMatch(/after:bg-\[linear-gradient/);
    expect(strip).toMatch(/aria-current/);
    expect(strip).toMatch(/strip\.scrollTo\(/);
    // Never scrollIntoView: a strip above the fold would pull the page up to itself.
    expect(strip).not.toMatch(/scrollIntoView/);
  });

  it('gives a focused item the same centring', () => {
    expect(strip).toMatch(/onFocusCapture/);
  });
});

describe('no page rolls its own strip', () => {
  // The old idiom: a `-mx-4 … overflow-x-auto … px-4` wrapper around a row of
  // links or chips. Tables, code blocks and the rails that are not tab strips
  // (the games rail, the map's filters, the explorer's area tabs) carry their
  // own idioms and are not matched here.
  const OLD_STRIP = /className="[^"]*-mx-4[^"]*overflow-x-auto[^"]*px-4[^"]*"/;
  const files = [
    ...walk(path.join(WEB, 'app', '[locale]', 'admin')),
    ...walk(path.join(WEB, 'app', '[locale]', 'klub')),
    path.join(WEB, 'components', 'clubs', 'office-nav.tsx'),
  ];

  it('in the admin panel, the office or the office nav', () => {
    const offenders = files.filter((file) => {
      const src = readFileSync(file, 'utf8');
      return [...src.matchAll(new RegExp(OLD_STRIP.source, 'g'))].some((m) => {
        // A scrolling TABLE wrapper is not a strip.
        const after = src.slice(m.index ?? 0, (m.index ?? 0) + 400);
        return !/<table|<pre/.test(after);
      });
    });
    expect(offenders.map((f) => path.relative(WEB, f))).toEqual([]);
  });

  it('uses the primitive in the admin nav, the office nav and the settings jump menu', () => {
    for (const file of [
      path.join(WEB, 'components', 'shell', 'admin-nav.tsx'),
      path.join(WEB, 'components', 'clubs', 'office-nav.tsx'),
      path.join(WEB, 'app', '[locale]', 'klub', '[slug]', '(office)', 'nastroyki', 'page.tsx'),
    ]) {
      expect(readFileSync(file, 'utf8'), path.relative(WEB, file)).toMatch(/<ScrollStrip/);
    }
  });
});

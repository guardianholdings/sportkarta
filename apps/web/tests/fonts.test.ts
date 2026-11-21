import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { HEADING_FONT } from '../lib/heading-font';

/**
 * How the web fonts are declared (app/fonts.css) — pinned, because every
 * mistake here still renders the right letters.
 *
 * Until 2026-11-17 the stylesheet imported one alphabet at a time, and those
 * package files carry no `unicode-range`: the browser fetched up to four files
 * for one weight to find the Cyrillic, the largest and least used first, and
 * redrew the page at each. A heading set in the fallback then reflowed the
 * first screen when its real font landed (a layout shift of 0.18 on a
 * throttled phone). Nothing looked wrong once the page had settled.
 */

const WEB = process.cwd(); // vitest runs with cwd = apps/web
const css = readFileSync(path.join(WEB, 'app', 'fonts.css'), 'utf8');
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
const PACKAGE = path.join(WEB, 'node_modules', '@fontsource', 'unbounded');

const compact = (range: string) => range.replace(/\s+/g, '');

/** `unicode-range` of each face in a stylesheet, keyed by the font file it loads. */
function rangesByFile(source: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, block] of source.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const file = /([a-z-]+-\d{3}-normal)\.woff2/.exec(block ?? '')?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(block ?? '')?.[1];
    if (file && range) found.set(file, compact(range));
  }
  return found;
}

describe('font imports', () => {
  const imports = [...code.matchAll(/@import\s+'(@fontsource\/[^']+)'/g)].map((m) => m[1] ?? '');

  it('are there at all', () => {
    expect(imports.length).toBeGreaterThanOrEqual(9);
  });

  it.each(imports)('%s is a weight, which carries its unicode ranges', (spec) => {
    // `…/800.css` declares every alphabet WITH a range; `…/cyrillic-800.css`
    // declares one alphabet WITHOUT, and four of those are four identical
    // faces the browser can only tell apart by downloading them.
    expect(spec).toMatch(/^@fontsource\/[a-z-]+\/\d{3}\.css$/);
    const file = readFileSync(path.join(WEB, 'node_modules', spec), 'utf8');
    const faces = file.match(/@font-face/g)?.length ?? 0;
    expect(faces).toBeGreaterThan(1);
    expect(file.match(/unicode-range/g)?.length).toBe(faces);
  });
});

describe('the heading font', () => {
  const ours = rangesByFile(code);
  const theirs = rangesByFile(readFileSync(path.join(PACKAGE, '800.css'), 'utf8'));

  it.each(Object.entries(HEADING_FONT))(
    'the %s file is the package’s own, byte for byte',
    (_locale, url) => {
      // A copy at a fixed address, because only a known name can be preloaded.
      // A package upgrade that changes the font must refresh the copy:
      //   cp node_modules/@fontsource/unbounded/files/<name> public/fonts/ui/
      const name = path.basename(url);
      const copy = readFileSync(path.join(WEB, 'public', url));
      const original = readFileSync(path.join(PACKAGE, 'files', name));
      expect(copy.equals(original), name).toBe(true);
      expect(code).toContain(`url('${url}')`);
    },
  );

  it('declares each alphabet with the range the package gives it', () => {
    expect([...ours.keys()].sort()).toEqual(
      ['cyrillic', 'cyrillic-ext', 'latin', 'latin-ext'].map((s) => `unbounded-${s}-800-normal`),
    );
    for (const [file, range] of ours) expect(range, file).toBe(theirs.get(file));
  });

  it('is not also imported from the package, which would declare it twice', () => {
    expect(code).not.toContain('@fontsource/unbounded/800.css');
  });
});

describe('fallbacks that keep the line breaks', () => {
  const tokens = readFileSync(path.join(WEB, 'app', 'design-tokens', 'fonts.css'), 'utf8');

  it.each([
    ['--font-display', 'Unbounded'],
    ['--font-sans', 'Golos Text'],
  ])('%s falls back to a width-matched %s', (token, family) => {
    const stack = new RegExp(`${token}:\\s*([^;]+);`).exec(tokens)?.[1] ?? '';
    // Directly after the face it stands in for, before any system family.
    expect(compact(stack)).toMatch(
      new RegExp(`^'${compact(family)}','${compact(family)}Fallback',`),
    );
    const faces = [...code.matchAll(/@font-face\s*\{([^}]*)\}/g)]
      .map((m) => m[1] ?? '')
      .filter((block) => block.includes(`'${family} Fallback'`));
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      expect(face).toMatch(/size-adjust:\s*\d+%/);
      // System fonts only: a fallback that had to be downloaded would be late too.
      expect(face).toMatch(/src:\s*local\(/);
      expect(face).not.toMatch(/url\(/);
    }
  });
});

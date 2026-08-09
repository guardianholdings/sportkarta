import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Design-token gate (RECONCILIATION.md PART B, item 6).
 *
 * Component code must consume the seed design tokens — Tailwind utilities that
 * resolve to CSS custom properties (bg-brand, text-ink, rounded-pill, …) — and
 * NEVER hardcode a raw hex colour or a raw px length. Hex/px belong in exactly
 * one place: app/design-tokens/*.css (the token layer). This scans the design
 * surface and fails on any literal, so a stray `#216543` or `h-[44px]` cannot
 * drift in.
 *
 * Escape hatch: a line containing `design-ok` is exempt (use for the few
 * geometric px a token cannot express — e.g. the MapMarker teardrop) and must
 * carry a reason. To keep this gate simple, design-surface files avoid hex/px
 * even in comments — reference tokens by their CSS-var name instead.
 */

const WEB_ROOT = join(__dirname, '..');

// Directories whose .ts/.tsx are held to the FULL contract (no hex, no px).
// These are the primitives and the token plumbing: nothing here has a reason to
// express a geometric length that a token cannot.
const SCANNED_DIRS = [
  join(WEB_ROOT, 'components', 'ui'),
  join(WEB_ROOT, 'lib', 'design'),
  join(WEB_ROOT, 'app', '[locale]', 'design-system'),
];

/**
 * Directories held to the COLOUR half of the contract only.
 *
 * The narrow three-directory scope above is how the pre-seed shadcn teal
 * (#0f766e) survived an entire design reconciliation in five files — the charts
 * on /statistika and /obshtina, the BarChart default, and the two MapLibre
 * markers on /dobavi — none of which the gate could see. theme-color-drift.test.ts
 * already exists because layout.tsx and manifest.ts sat outside this gate for
 * exactly the same reason; rather than add a third bespoke pin, the colour rule
 * now covers every screen, every component and lib/ — with four named
 * exemptions below, each of which cannot reference a custom property at all and
 * is pinned by its own mirror test instead.
 *
 * Only hex is checked here, not px: product screens legitimately express layout
 * geometry the token scale does not cover (a 76px nav rail, a 168px sheet peek),
 * and forcing those through tokens would be noise, not discipline.
 */
const COLOR_ONLY_DIRS = [
  join(WEB_ROOT, 'components'),
  join(WEB_ROOT, 'app', '[locale]'),
  join(WEB_ROOT, 'lib'),
];

/**
 * Files that must carry literal hex because their output cannot reference a CSS
 * custom property at all. Each needs a reason, and the list must stay short.
 */
const COLOR_EXEMPT = new Set([
  // A MapLibre style is a JSON document handed to WebGL, not a stylesheet.
  join('lib', 'map', 'style.ts'),
  // `viewport.themeColor` becomes a <meta> tag that paints browser chrome
  // OUTSIDE the document — it cannot reference a custom property. It is pinned
  // against the token layer by tests/theme-color-drift.test.ts instead.
  join('app', '[locale]', 'layout.tsx'),
  // satori (the OG image renderer) resolves no CSS variables, so the card
  // palette must duplicate the literals. It is pinned value-for-value against
  // colors.css by tests/og-assets.test.ts.
  join('lib', 'og', 'palette.ts'),
  // The municipality embed is served with `script-src 'none'` and inline CSS
  // into a THIRD PARTY's page: it can carry neither our custom properties nor
  // our stylesheet. RECONCILIATION §4 records this constraint.
  join('lib', 'widget.ts'),
]);

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/;
const PX = /\b\d+(?:\.\d+)?px\b/;

/** Blank comment contents while preserving newlines (keeps line numbers). A
 * design value mentioned in a doc comment is documentation, not code — only
 * real code is held to the token contract. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
}

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // directory may not exist yet
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out = out.concat(walk(full));
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

interface Offense {
  file: string;
  line: number;
  kind: 'hex' | 'px';
  text: string;
}

function scanFile(file: string, checkPx: boolean, offenses: Offense[]): void {
  const rel = file.slice(WEB_ROOT.length + 1);
  if (COLOR_EXEMPT.has(rel)) return;
  const src = readFileSync(file, 'utf8');
  const rawLines = src.split('\n');
  // Strip comments (documentation may cite px/hex) before scanning code.
  stripComments(src)
    .split('\n')
    .forEach((line, i) => {
      const raw = rawLines[i] ?? '';
      // A `design-ok` marker lives in a comment (now stripped) — read it raw.
      if (raw.includes('design-ok')) return;
      if (HEX.test(line)) offenses.push({ file: rel, line: i + 1, kind: 'hex', text: raw.trim() });
      if (checkPx && PX.test(line)) {
        offenses.push({ file: rel, line: i + 1, kind: 'px', text: raw.trim() });
      }
    });
}

function scan(): Offense[] {
  const offenses: Offense[] = [];
  const done = new Set<string>();
  for (const dir of SCANNED_DIRS) {
    for (const file of walk(dir)) {
      done.add(file);
      scanFile(file, true, offenses);
    }
  }
  for (const dir of COLOR_ONLY_DIRS) {
    for (const file of walk(dir)) {
      if (done.has(file)) continue; // already held to the stricter rule
      scanFile(file, false, offenses);
    }
  }
  return offenses;
}

describe('design-token gate', () => {
  it('no hardcoded hex colours or raw px in the design surface', () => {
    const offenses = scan();
    const report = offenses.map((o) => `  ${o.file}:${o.line} [${o.kind}] ${o.text}`).join('\n');
    expect(offenses, `Hardcoded design values found — use a token instead:\n${report}`).toEqual([]);
  });

  // `walk()` swallows ENOENT, so a renamed or mistyped directory disables its
  // half of the gate silently. Both lists are asserted, per directory — not
  // `.some()`, which one healthy entry would satisfy for all of them.
  it.each([...SCANNED_DIRS, ...COLOR_ONLY_DIRS])('scans %s', (dir) => {
    expect(
      walk(dir).length,
      `${dir} matched no .ts/.tsx — the gate is not running there`,
    ).toBeGreaterThan(0);
  });
});

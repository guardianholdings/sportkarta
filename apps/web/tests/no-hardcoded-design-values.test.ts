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

// Directories whose .ts/.tsx are held to the token contract.
const SCANNED_DIRS = [
  join(WEB_ROOT, 'components', 'ui'),
  join(WEB_ROOT, 'lib', 'design'),
  join(WEB_ROOT, 'app', '[locale]', 'design-system'),
];

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

interface Offense { file: string; line: number; kind: 'hex' | 'px'; text: string }

function scan(): Offense[] {
  const offenses: Offense[] = [];
  for (const dir of SCANNED_DIRS) {
    for (const file of walk(dir)) {
      const rel = file.slice(WEB_ROOT.length + 1);
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
          if (PX.test(line)) offenses.push({ file: rel, line: i + 1, kind: 'px', text: raw.trim() });
        });
    }
  }
  return offenses;
}

describe('design-token gate', () => {
  it('no hardcoded hex colours or raw px in the design surface', () => {
    const offenses = scan();
    const report = offenses
      .map((o) => `  ${o.file}:${o.line} [${o.kind}] ${o.text}`)
      .join('\n');
    expect(offenses, `Hardcoded design values found — use a token instead:\n${report}`).toEqual([]);
  });

  it('actually scans files (guards against a broken/empty glob)', () => {
    const anyFiles = SCANNED_DIRS.some((d) => walk(d).length > 0);
    expect(anyFiles).toBe(true);
  });
});

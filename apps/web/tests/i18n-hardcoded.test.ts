import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// i18n gate (part 2): no hardcoded Bulgarian UI strings outside message files.
// Heuristic — flag any run of 2+ Cyrillic letters in scanned source, after
// stripping comments. This reliably catches hardcoded bg copy (the real risk
// for a bg-first product) while ignoring comments and single-char literals
// (e.g. keyboard-key comparisons like `key === 'в'`). Translatable UI text must
// live in messages/*.json (not scanned); place-name data lives in *.json too.

const WEB_ROOT = process.cwd(); // vitest runs with cwd = apps/web
const SCAN_DIRS = ['app', 'components', 'lib'];
const CYRILLIC_RUN = /[Ѐ-ӿ]{2,}/;

// Files intentionally exempt (data, not translatable UI). Keep this minimal and
// justified; prefer moving data to *.json over adding entries here.
const ALLOWLIST = new Set<string>([]);

/** Blank comment contents while preserving newlines (keeps line numbers). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
}

/** 1-indexed line numbers containing a 2+ Cyrillic run in non-comment code. */
export function findHardcodedCyrillic(src: string): number[] {
  const hits: number[] = [];
  stripComments(src)
    .split('\n')
    .forEach((line, i) => {
      if (CYRILLIC_RUN.test(line)) hits.push(i + 1);
    });
  return hits;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe('findHardcodedCyrillic (detector)', () => {
  it('flags a hardcoded Cyrillic string literal', () => {
    expect(findHardcodedCyrillic(`const label = 'Здравей';`)).toEqual([1]);
  });
  it('flags hardcoded Cyrillic JSX text', () => {
    expect(findHardcodedCyrillic(`<span>Спортни съоръжения</span>`)).toEqual([1]);
  });
  it('ignores Cyrillic inside line comments', () => {
    expect(findHardcodedCyrillic(`const x = 1; // това е коментар`)).toEqual([]);
  });
  it('ignores Cyrillic inside block/JSDoc comments spanning lines', () => {
    expect(findHardcodedCyrillic(`/**\n * V/В = active\n */\nconst x = 1;`)).toEqual([]);
  });
  it('ignores single-character Cyrillic literals (keyboard keys)', () => {
    expect(findHardcodedCyrillic(`if (key === 'в' || key === 'с') {}`)).toEqual([]);
  });
  it('ignores plain Latin code', () => {
    expect(findHardcodedCyrillic(`const title = 'Sports facilities';`)).toEqual([]);
  });
});

describe('no hardcoded Cyrillic UI strings in apps/web source', () => {
  it('every scanned .ts/.tsx uses i18n for Bulgarian copy', () => {
    const violations: string[] = [];
    for (const dir of SCAN_DIRS) {
      const base = path.join(WEB_ROOT, dir);
      for (const file of walk(base)) {
        const rel = path.relative(WEB_ROOT, file);
        if (ALLOWLIST.has(rel)) continue;
        for (const line of findHardcodedCyrillic(readFileSync(file, 'utf8'))) {
          violations.push(`${rel}:${String(line)}`);
        }
      }
    }
    expect(
      violations,
      `Hardcoded Cyrillic found (move to messages/*.json):\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});

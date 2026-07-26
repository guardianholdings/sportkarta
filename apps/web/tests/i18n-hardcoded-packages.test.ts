import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * i18n gate, part 3: no hardcoded Bulgarian UI copy in the WORKSPACE PACKAGES.
 *
 * WHY A THIRD GATE. tests/i18n-hardcoded.test.ts is strong but its reach stops
 * at the web app: it scans `apps/web/{app,components,lib}` because its root is
 * `process.cwd()`, which is apps/web when vitest runs there. The repo-root `lib`
 * package and `apps/worker/src` are scanned by NOTHING — and those are exactly
 * where the next batch of member-facing Bulgarian wants to live:
 *
 *   - every mail body is rendered in lib/src/email and SENT from apps/worker
 *     (CLAUDE.md fixes all sending in the worker), so a streak nudge or a
 *     campaign-close mail written there would ship hardcoded and stay green;
 *   - share text (the Wordle-style week) is assembled from templates that would
 *     naturally sit beside the badge/streak code in lib/src.
 *
 * Both are one `git add` away from being permanently untranslatable, and the
 * failure is invisible: bg is the source locale, so hardcoded Bulgarian LOOKS
 * right to every reviewer until somebody opens /en.
 *
 * WHY THE ALLOWLIST IS NOT EMPTY (unlike the web gate's). The web app contains
 * only UI, so "any Cyrillic is a bug" is exactly right there. These packages
 * also contain Bulgarian *data* and *language algorithms*, which are not
 * translatable UI and must not move into messages/*.json:
 *
 *   - a transliteration rule keyed on the letters it transliterates;
 *   - a parsing lexicon that maps registry column headers to our vocabulary;
 *   - a catalogue of the real Bulgarian names of external institutions;
 *   - the ministry report annex, which CLAUDE.md deliberately keeps OUT of i18n
 *     ("an annex is a ministry-specified document format that must read
 *     identically in any UI locale") — and note the stated reason for that
 *     decision was to keep the WEB gate's allowlist empty.
 *
 * Every entry below is one of those categories. An entry is a decision that the
 * strings in that path are data rather than copy, so adding one should be at
 * least as uncomfortable as adding a translation.
 *
 * Test files are not scanned: a fixture asserting that "Пловдив" slugifies to
 * "plovdiv" has to contain "Пловдив".
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');

/** Roots held to the no-hardcoded-copy contract. */
const SCANNED_ROOTS = [join(REPO_ROOT, 'lib', 'src'), join(REPO_ROOT, 'apps', 'worker', 'src')];

/**
 * Repo-relative paths exempt because they carry Bulgarian DATA, not UI copy.
 * A directory entry exempts everything beneath it. Keep this list short and
 * justified; prefer moving copy into messages/*.json over adding an entry.
 */
const ALLOWLIST = new Map<string, string>([
  [
    'lib/src/reports',
    'Ministry annex: a specified document format that must read identically in ' +
      'any UI locale. CLAUDE.md puts these field names in the catalogue on purpose.',
  ],
  [
    'lib/src/import-municipal/normalize.ts',
    'Parsing lexicon: maps Bulgarian registry column headers and cell values ' +
      '("свободен" → free) onto our vocabulary. Input data, never rendered.',
  ],
  [
    'lib/src/external-sources/catalog.ts',
    'The real Bulgarian names of external institutions and registers. A ' +
      'translated ministry name would misname the source it cites.',
  ],
  [
    'lib/src/slug.ts',
    'Transliteration algorithm keyed on the letters it transliterates ' +
      '(the word-final "ия" rule). Translating it would delete the feature.',
  ],
]);

const CYRILLIC_RUN = /[Ѐ-ӿ]{2,}/;

/** Blank comment contents while preserving newlines (keeps line numbers). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
}

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (name === 'node_modules' || name === 'dist') continue;
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    // Fixtures legitimately contain Bulgarian — see the header.
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function isAllowed(rel: string): boolean {
  const posix = rel.split(sep).join('/');
  for (const entry of ALLOWLIST.keys()) {
    if (posix === entry || posix.startsWith(`${entry}/`)) return true;
  }
  return false;
}

interface Offense {
  file: string;
  line: number;
  text: string;
}

function scan(): { offenses: Offense[]; scanned: number } {
  const offenses: Offense[] = [];
  let scanned = 0;
  for (const root of SCANNED_ROOTS) {
    for (const file of walk(root)) {
      const rel = relative(REPO_ROOT, file);
      if (isAllowed(rel)) continue;
      scanned += 1;
      const raw = readFileSync(file, 'utf8').split('\n');
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          if (CYRILLIC_RUN.test(line)) {
            offenses.push({ file: rel, line: i + 1, text: (raw[i] ?? '').trim() });
          }
        });
    }
  }
  return { offenses, scanned };
}

describe('i18n gate — workspace packages', () => {
  it('no hardcoded Bulgarian outside the message catalogues', () => {
    const { offenses } = scan();
    const report = offenses.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n');
    expect(
      offenses,
      'Hardcoded Bulgarian found in a workspace package. UI copy belongs in ' +
        'apps/web/messages/bg.json (mirrored in en.json). If the string is DATA ' +
        'rather than copy, add a justified ALLOWLIST entry in this file:\n' +
        report,
    ).toEqual([]);
  });

  it('actually scans files (guards against a broken glob or a swallowed root)', () => {
    const { scanned } = scan();
    // lib/src alone is dozens of modules; a single digit means a path broke.
    expect(scanned).toBeGreaterThan(20);
  });

  it('every allowlist entry still exists and still needs the exemption', () => {
    // A stale entry silently un-guards a path that was later cleaned up, and is
    // also how an allowlist grows without anyone noticing.
    for (const [entry, reason] of ALLOWLIST) {
      const full = join(REPO_ROOT, entry);
      expect(() => statSync(full), `allowlisted path no longer exists: ${entry}`).not.toThrow();
      expect(reason.length, `allowlist entry ${entry} needs a reason`).toBeGreaterThan(30);

      const files = statSync(full).isDirectory() ? walk(full) : [full];
      const stillHasCyrillic = files.some((f) =>
        stripComments(readFileSync(f, 'utf8'))
          .split('\n')
          .some((l) => CYRILLIC_RUN.test(l)),
      );
      expect(
        stillHasCyrillic,
        `${entry} no longer contains Bulgarian — drop its ALLOWLIST entry so the path is guarded again.`,
      ).toBe(true);
    }
  });
});

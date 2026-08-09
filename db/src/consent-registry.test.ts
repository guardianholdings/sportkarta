import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * THE CONSENT REGISTRY — docs/ENGAGEMENT-IMPLEMENTATION.md §7.
 *
 * CLAUDE.md states the rule this enforces: who may appear on a public ranking is
 * defined ONCE, in the `leaderboard_eligible_members` view, and "every ranking
 * joins that view instead of `users`, so a new slice inherits the consent rule".
 * Until now nothing checked it. The rule survived because the people writing
 * rankings happened to know it — which is exactly the kind of guarantee that
 * holds until it is 6pm and somebody needs one more board.
 *
 * WHY PER-FUNCTION AND NOT PER-FILE. The plan called this out specifically:
 * per-file scanning is already defeated in this repo. `db/src/campaigns.ts`
 * mentions `leaderboard_eligible_members` several times AND separately contains
 * `adminStandings`, which joins `users` directly. A file-level "does it mention
 * the view" check passes that file while the bypass sits inside it. So the unit
 * is the exported function: each one that both builds SQL and selects a
 * person-identifying column must name the view in its own body.
 *
 * WHY IT SCANS EVERY MODULE rather than a list of the ranking ones: a list is a
 * thing a new file can be left off. The allowlist below is the only escape, it
 * is small, and every entry carries the reason it is safe — so widening it is a
 * decision somebody has to write down.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Columns that name a person on a public surface. */
const PERSON_COLUMNS = ['public_handle', 'display_name'];

const VIEW = 'leaderboard_eligible_members';

/**
 * Functions that select a person column WITHOUT the view, legitimately.
 *
 * Each entry is a claim that the function is not a public ranking. Adding one
 * means arguing that case in writing, which is the point of the mechanism.
 */
const ALLOWED: Record<string, string> = {
  'campaigns.ts:adminStandings':
    'The ADMIN board. It deliberately shows every scored member including the unpublished ones, because an operator awarding a prize must see who actually won — campaign scoring counts everyone and only DISPLAY is gated. Reachable only behind requireRole, and never rendered publicly.',
  'passport.ts:publicPassportOwner':
    'Resolves ONE passport by handle, and carries the visibility predicate itself — it is the function the view would otherwise be asked to duplicate. It is also what every public passport read is gated by, so making it depend on the view would be circular.',
  'digest.ts:digestRecipients':
    'Addresses a member’s OWN weekly mail. It names the recipient to themselves, discloses nobody to anybody, and gating it on a public-passport opt-in would stop a private member receiving their own digest.',
};

interface Fn {
  key: string;
  name: string;
  body: string;
}

/**
 * Exported function bodies, by brace matching.
 *
 * Crude on purpose: a parser dependency for one gate is a worse trade than a
 * scanner whose failure mode is over-reporting, and over-reporting here means a
 * human reads a function and either fixes it or writes down why it is fine.
 */
function exportedFunctions(source: string, file: string): Fn[] {
  const found: Fn[] = [];
  const signature = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = signature.exec(source)) !== null) {
    // Skip the PARAMETER LIST before looking for the body's brace. Without this
    // a default parameter — `options: StandingsOptions = {}`, which most of
    // these functions have — is mistaken for the body, and the scan silently
    // passes because a one-character body mentions no person column. That is
    // the failure mode a gate must not have, so it is asserted below too.
    const paramsOpen = source.indexOf('(', match.index);
    if (paramsOpen === -1) continue;
    let parens = 0;
    let paramsEnd = -1;
    for (let i = paramsOpen; i < source.length; i += 1) {
      if (source[i] === '(') parens += 1;
      else if (source[i] === ')') {
        parens -= 1;
        if (parens === 0) {
          paramsEnd = i;
          break;
        }
      }
    }
    if (paramsEnd === -1) continue;
    const open = source.indexOf('{', paramsEnd);
    if (open === -1) continue;
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    found.push({ key: `${file}:${match[1]}`, name: match[1] ?? '', body: source.slice(open, end) });
  }
  return found;
}

function modules(): { file: string; source: string }[] {
  return readdirSync(HERE)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((file) => ({ file, source: readFileSync(join(HERE, file), 'utf8') }));
}

/** Strip comments, so a function is not excused by a mention in its own docstring. */
function code(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('consent registry', () => {
  it('finds the modules it is supposed to be scanning', () => {
    const names = modules().map((m) => m.file);
    expect(names).toContain('leaderboard.ts');
    expect(names).toContain('campaigns.ts');
    expect(names).toContain('divisions.ts');
  });

  /**
   * The scanner must actually extract BODIES. Its first version stopped at a
   * default parameter's `{}`, so every function came back one character long and
   * the whole gate passed while checking nothing. A scanner that fails open is
   * worse than no scanner, because it is also a claim.
   */
  it('extracts real function bodies, not a stray brace', () => {
    const all = modules().flatMap(({ file, source }) => exportedFunctions(source, file));
    expect(all.length).toBeGreaterThan(20);
    const trivial = all.filter((fn) => fn.body.length < 20).map((fn) => fn.key);
    expect(trivial).toEqual([]);
    // And at least one function really does reach its SQL.
    const standings = all.find((fn) => fn.name === 'weekStandings');
    expect(standings?.body).toContain(VIEW);
  });

  it('every SQL-building function that names a person joins the eligibility view', () => {
    const offenders: string[] = [];

    for (const { file, source } of modules()) {
      for (const fn of exportedFunctions(source, file)) {
        const body = code(fn.body);
        if (!body.includes('sql`')) continue;
        if (!PERSON_COLUMNS.some((column) => body.includes(column))) continue;
        if (body.includes(VIEW)) continue;
        if (fn.key in ALLOWED) continue;
        offenders.push(fn.key);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the allowlist has no stale entries — every exemption still names a real function', () => {
    const all = new Set(
      modules().flatMap(({ file, source }) => exportedFunctions(source, file).map((f) => f.key)),
    );
    for (const key of Object.keys(ALLOWED)) {
      expect(all.has(key), `${key} is allowlisted but no longer exists`).toBe(true);
    }
  });

  it('every exemption is justified in writing, not merely listed', () => {
    for (const [key, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, `${key} needs a real reason`).toBeGreaterThan(80);
    }
  });

  /**
   * The gate proving the gate. A public ranking that selects a handle without
   * the view must be REPORTED — if this passes with the scanner disabled, the
   * test above is decoration.
   */
  it('would catch a ranking that bypassed the view', () => {
    const bypass = `
      export async function sneakyBoard(db) {
        return db.execute(sql\`
          SELECT u.public_handle AS handle, u.display_name, sum(p.points) AS points
          FROM points_ledger p JOIN users u ON u.id = p.user_id
          GROUP BY u.id ORDER BY points DESC
        \`);
      }
    `;
    const fns = exportedFunctions(bypass, 'fake.ts');
    expect(fns).toHaveLength(1);
    const body = code(fns[0]?.body ?? '');
    expect(body.includes('sql`')).toBe(true);
    expect(PERSON_COLUMNS.some((c) => body.includes(c))).toBe(true);
    expect(body.includes(VIEW)).toBe(false);
  });

  /**
   * And the divisions half specifically: both the display query and the
   * assignment query must name the view, because gating only one of them is the
   * plausible mistake. The rollover reads `weekStandings`, so a bypass there
   * would decide promotions from a field the ladder never showed.
   */
  it('both division queries name the view', () => {
    const source = readFileSync(join(HERE, 'divisions.ts'), 'utf8');
    for (const name of ['weekStandings', 'divisionCandidates']) {
      const fn = exportedFunctions(source, 'divisions.ts').find((f) => f.name === name);
      expect(fn, `${name} not found`).toBeDefined();
      expect(code(fn?.body ?? '')).toContain(VIEW);
    }
  });
});

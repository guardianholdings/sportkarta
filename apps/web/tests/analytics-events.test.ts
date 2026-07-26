import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ANALYTICS_EVENTS, ANALYTICS_EVENT_VALUES } from '../lib/analytics-events';

/**
 * Analytics gate: every `data-umami-event` value comes from the declared
 * vocabulary in lib/analytics-events.ts.
 *
 * WHY. Umami v2 autotracks any element carrying the attribute — no import, no
 * helper, no review surface. Instrumenting is a one-attribute edit, which is
 * exactly why the vocabulary needs a gate: the natural next edit is
 * `data-umami-event={`facility_${slug}`}` or an outcome dimension carrying
 * `unscored_daily_cap`, and either turns a product metric into a behavioural
 * record about a named person. The site publishes the opposite promise at
 * /privacy ("не създаваме профили"), so this is a published-promise gate, not a
 * style rule.
 *
 * What it enforces:
 *   - every attribute value is a literal `{ANALYTICS_EVENTS.x}` reference, never
 *     a template literal, concatenation or bare string;
 *   - no `data-umami-event-*` DIMENSION attributes at all (that is the channel
 *     an id or an anti-abuse outcome would travel through);
 *   - the vocabulary itself stays free of anything that looks like a subject.
 */

const WEB_ROOT = join(__dirname, '..');
const SCANNED_DIRS = [join(WEB_ROOT, 'app'), join(WEB_ROOT, 'components')];

/** Tokens that would mean the event names a SUBJECT rather than a surface. */
const FORBIDDEN_IN_NAMES = [
  'slug',
  'id',
  'handle',
  'email',
  'user',
  'member',
  'facility_id',
  'occurrence',
  'municipality',
  'lat',
  'lon',
];

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
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

interface Usage {
  file: string;
  line: number;
  raw: string;
  value: string;
}

/**
 * Scans whole-file rather than line-by-line, deliberately.
 *
 * A line-based scanner misses an attribute whose value is wrapped across lines
 * — which prettier does automatically as soon as the expression is a ternary —
 * and a missed attribute is not a false negative in the harmless direction: it
 * escapes the vocabulary check completely. That is exactly the shape an
 * exfiltrating value would take:
 *
 *     data-umami-event={
 *       `facility_${slug}`
 *     }
 *
 * Found by this file's own "no dead vocabulary" assertion, which flagged two
 * events as uninstrumented while they were in fact instrumented across a line
 * break and simply invisible to the old regex.
 */
function scan(): { usages: Usage[]; dimensions: Usage[]; scanned: number } {
  const usages: Usage[] = [];
  const dimensions: Usage[] = [];
  let scanned = 0;
  const lineOf = (src: string, index: number): number => src.slice(0, index).split('\n').length;

  for (const dir of SCANNED_DIRS) {
    for (const file of walk(dir)) {
      scanned += 1;
      const rel = relative(WEB_ROOT, file).split(sep).join('/');
      const src = readFileSync(file, 'utf8');

      // A dimension attribute — data-umami-event-<name> — is how an id or an
      // outcome would be attached. None are permitted.
      for (const m of src.matchAll(/data-umami-event-[a-z-]+/g)) {
        dimensions.push({
          file: rel,
          line: lineOf(src, m.index),
          raw: m[0],
          value: m[0],
        });
      }

      // `[^}]*` still terminates at the first `}`, which is correct here: every
      // permitted value is a member expression or a ternary over them, and none
      // contains a nested brace. A value that DID contain one would fail the
      // reference assertion below rather than slip past it.
      for (const m of src.matchAll(/data-umami-event=(\{[\s\S]*?\}|"[^"]*"|'[^']*')/g)) {
        const value = (m[1] ?? '').replace(/\s+/g, ' ').trim();
        usages.push({ file: rel, line: lineOf(src, m.index), raw: value, value });
      }
    }
  }
  return { usages, dimensions, scanned };
}

const { usages, dimensions, scanned } = scan();

describe('analytics event vocabulary', () => {
  it('actually scans the app (guards a vacuous pass)', () => {
    expect(scanned).toBeGreaterThan(50);
  });

  it('the vocabulary is instrumented somewhere', () => {
    // If every attribute were deleted, the gate below would pass on an empty
    // set and C1 would silently stop measuring anything.
    expect(usages.length).toBeGreaterThan(0);
  });

  it('every value is built only from ANALYTICS_EVENTS references', () => {
    // Permits a member expression and a ternary over two of them (the RSVP
    // button is one element whose meaning depends on `attending`), and nothing
    // else. The rule is expressed as "contains a reference AND contains no
    // literal-or-concatenation syntax", so it holds for shapes not anticipated
    // here without silently widening to allow a string.
    const bad = usages.filter((u) => {
      const hasReference = /ANALYTICS_EVENTS\.[A-Za-z]+/.test(u.value);
      const hasLiteral = /["'`]/.test(u.value) || u.value.includes('+');
      return !hasReference || hasLiteral;
    });
    expect(
      bad,
      'data-umami-event must be built from ANALYTICS_EVENTS references only. A bare ' +
        'string, a template literal or a concatenation bypasses the closed vocabulary — ' +
        'which is how a facility slug or an account id ends up in the event stream:\n' +
        bad.map((u) => `  ${u.file}:${u.line}  ${u.raw}`).join('\n'),
    ).toEqual([]);
  });

  it('carries no dimension attributes', () => {
    expect(
      dimensions,
      'data-umami-event-* attaches a DIMENSION to an event, which is the channel an ' +
        'identifier or an anti-abuse outcome would travel through. The vocabulary is ' +
        'deliberately dimensionless:\n' +
        dimensions.map((u) => `  ${u.file}:${u.line}  ${u.raw}`).join('\n'),
    ).toEqual([]);
  });

  it('no declared event name references a subject', () => {
    for (const value of ANALYTICS_EVENT_VALUES) {
      for (const token of FORBIDDEN_IN_NAMES) {
        expect(
          value.includes(token),
          `event "${value}" contains "${token}" — events name a SURFACE and an ACTION, ` +
            'never what was acted on.',
        ).toBe(false);
      }
    }
  });

  it('event names are stable, lowercase snake_case identifiers', () => {
    // Renaming an event silently breaks the historical series in Umami, so the
    // shape is pinned rather than left to habit.
    for (const value of ANALYTICS_EVENT_VALUES) {
      expect(value, `${value} must be lowercase snake_case`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expect(new Set(ANALYTICS_EVENT_VALUES).size).toBe(ANALYTICS_EVENT_VALUES.length);
  });

  it('every declared event is actually used (no dead vocabulary)', () => {
    const used = new Set<string>();
    for (const u of usages) {
      for (const m of u.value.matchAll(/ANALYTICS_EVENTS\.([A-Za-z]+)/g)) {
        const value = ANALYTICS_EVENTS[m[1] as keyof typeof ANALYTICS_EVENTS];
        if (value) used.add(value);
      }
    }
    const unused = ANALYTICS_EVENT_VALUES.filter((v) => !used.has(v));
    expect(
      unused,
      `declared but never instrumented — either wire it up or delete it:\n  ${unused.join('\n  ')}`,
    ).toEqual([]);
  });
});

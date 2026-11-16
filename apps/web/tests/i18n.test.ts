import {
  CLUB_AUDIT_ACTIONS,
  CLUB_CHARGE_KINDS,
  CLUB_FEATURES,
  CLUB_KINDS,
  CLUB_PAYMENT_METHODS_ALL,
  CLUB_TIERS,
} from '@sportkarta/lib/clubs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

// bg is the source of truth (CLAUDE.md); en must mirror it exactly so the
// completeness gate never silently ships untranslated UI.
describe('i18n message parity', () => {
  const bgKeys = new Set(flattenKeys(bg));
  const enKeys = new Set(flattenKeys(en));

  it('every bg key has an en translation', () => {
    expect([...bgKeys].filter((key) => !enKeys.has(key))).toEqual([]);
  });

  it('en declares no keys that are missing from bg', () => {
    expect([...enKeys].filter((key) => !bgKeys.has(key))).toEqual([]);
  });
});

/**
 * A key written twice in one object is legal JSON: the parser keeps the LAST
 * one and says nothing, so the parity test above — which reads the parsed
 * catalogue — cannot see it. The string a page gets is then whichever line
 * came later, and a newly added key silently loses to an older one of the same
 * name (found 2026-11-14: a new `card.refund` button printed the older
 * `card.refund` row label). So this reads the files as TEXT.
 */
describe('no message key is written twice in one object', () => {
  function repeatedKeys(text: string): string[] {
    const repeated: string[] = [];
    // One entry per open container: the keys seen so far (an object), or null
    // (an array, whose strings are values).
    const open: (Set<string> | null)[] = [];
    const path: string[] = [];
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '{') {
        open.push(new Set());
        path.push('');
      } else if (ch === '[') {
        open.push(null);
        path.push('');
      } else if (ch === '}' || ch === ']') {
        open.pop();
        path.pop();
      } else if (ch === '"') {
        let end = i + 1;
        while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
        const literal = text.slice(i + 1, end);
        i = end;
        // A string followed by a colon is a key of the innermost object.
        let after = end + 1;
        while (/\s/.test(text[after] ?? '')) after += 1;
        const keys = open.at(-1);
        if (keys && text[after] === ':') {
          if (keys.has(literal)) repeated.push([...path.slice(0, -1), literal].join(' → '));
          keys.add(literal);
          path[path.length - 1] = literal;
        }
      }
      i += 1;
    }
    return repeated;
  }

  it('the scanner itself sees a repeat, and only a repeat', () => {
    expect(
      repeatedKeys('{"a": {"x": 1, "y": "x", "x": 2}, "b": ["x", "x"], "a2": {"x": 1}}'),
    ).toEqual(['a → x']);
  });

  it.each(['bg', 'en'])('%s.json repeats no key', (locale) => {
    const text = readFileSync(join(__dirname, '..', 'messages', `${locale}.json`), 'utf8');
    expect(repeatedKeys(text)).toEqual([]);
  });
});

/**
 * next-intl reads a dot in a key as NESTING, and refuses a catalogue that has
 * one in a literal key — at request time, with a 500, not at build time. The
 * parity test above cannot see the difference, because it flattens `{error:
 * {generic}}` and `{"error.generic"}` to the same string. So this checks the
 * raw shape instead: it is the only place a `"error.generic": "…"` typo is
 * caught before somebody hits the page.
 */
describe('message keys are nested, never dotted', () => {
  function dottedKeys(value: unknown, path: string[] = []): string[] {
    if (typeof value !== 'object' || value === null) return [];
    return Object.entries(value).flatMap(([key, child]) => [
      ...(key.includes('.') ? [[...path, key].join(' → ')] : []),
      ...dottedKeys(child, [...path, key]),
    ]);
  }

  it('bg declares no key containing a dot', () => {
    expect(dottedKeys(bg)).toEqual([]);
  });

  it('en declares no key containing a dot', () => {
    expect(dottedKeys(en)).toEqual([]);
  });
});

/**
 * A closed vocabulary the office renders as `t(\`<namespace>.${value}\`)` must
 * have a label for every value — a new audit action, payment method or charge
 * kind (each widened by a migration) otherwise shows its raw key in the
 * club's history. bg is checked; parity above carries it to en.
 */
describe('club vocabularies have labels', () => {
  const keys = new Set(flattenKeys(bg));
  it.each([
    ['ClubAudit.action', CLUB_AUDIT_ACTIONS],
    ['Club.method', CLUB_PAYMENT_METHODS_ALL],
    ['Club.chargeKind', CLUB_CHARGE_KINDS],
    // The clubs page derives its audience tiles, pricing grid and tier chips
    // from these three (apps/web/lib/clubs/landing.ts).
    ['Club.feature', CLUB_FEATURES],
    ['Club.kind', CLUB_KINDS],
    ['Club.tier', CLUB_TIERS],
  ] as const)('%s', (namespace, values) => {
    expect(values.filter((value) => !keys.has(`${namespace}.${value}`))).toEqual([]);
  });
});

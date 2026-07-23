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

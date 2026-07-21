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

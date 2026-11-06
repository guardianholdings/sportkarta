import { readFileSync } from 'node:fs';
import path from 'node:path';

import { CLUB_VAT_RATE_PERCENT } from '@sportkarta/lib/clubs';
import { describe, expect, it } from 'vitest';

/**
 * Club prices are NET of VAT (operator decision 2026-11-06; the association is
 * registered under ЗДДС). The amounts live in lib/src/clubs/pricing-public.ts;
 * the words beside them live here, and every surface that prints a tier price
 * must say so — a club must not learn about the 20 % from the first invoice.
 */

function messages(locale: 'bg' | 'en'): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'messages', `${locale}.json`), 'utf8'),
  ) as Record<string, unknown>;
}

function pick(tree: Record<string, unknown>, dotted: string): string {
  let node: unknown = tree;
  for (const key of dotted.split('.')) node = (node as Record<string, unknown>)[key];
  expect(typeof node, dotted).toBe('string');
  return node as string;
}

/** Every string printed next to a tier price. */
const PRICE_STRINGS = [
  'ClubsLanding.pricing.perMonth',
  'ClubsLanding.pricing.vatNote',
  'ClubApply.tierHint.community',
  'ClubApply.tierHint.standard',
  'ClubApply.tierHint.pro',
];

/**
 * The clubs terms' price clause lands with PR #54 (`/usloviya-klubove`); it is
 * checked whenever the key exists so the gate closes over it the day it merges.
 */
const PRICE_STRINGS_WHEN_PRESENT = ['ClubTerms.contract.invoicing'];

function present(tree: Record<string, unknown>, dotted: string): boolean {
  let node: unknown = tree;
  for (const key of dotted.split('.')) {
    if (typeof node !== 'object' || node === null || !(key in node)) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'string';
}

function priceStrings(tree: Record<string, unknown>): string[] {
  return [...PRICE_STRINGS, ...PRICE_STRINGS_WHEN_PRESENT.filter((key) => present(tree, key))];
}

describe('club prices are stated net of VAT', () => {
  it('bg: every price surface says «без ДДС» and none says the price includes it', () => {
    const tree = messages('bg');
    for (const key of priceStrings(tree)) {
      const text = pick(tree, key);
      expect(text, key).toMatch(/без ДДС/);
      expect(text, key).not.toMatch(/с ДДС|включен ДДС|с включен/);
    }
  });

  it('en: every price surface says VAT is excluded', () => {
    const tree = messages('en');
    for (const key of priceStrings(tree)) {
      const text = pick(tree, key);
      expect(text, key).toMatch(/excl\. VAT|exclude VAT/);
      expect(text, key).not.toMatch(/incl\. VAT|including VAT|VAT included/);
    }
  });

  it('prints the statutory rate from the constant, in the note under the plans only', () => {
    expect(CLUB_VAT_RATE_PERCENT).toBe(20);
    for (const locale of ['bg', 'en'] as const) {
      const tree = messages(locale);
      expect(pick(tree, 'ClubsLanding.pricing.vatNote')).toContain('{vat} %');
      for (const key of priceStrings(tree)) expect(pick(tree, key), key).not.toMatch(/\b20 ?%/);
    }
  });
});

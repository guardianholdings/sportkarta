import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { arrangeDeck } from '@/lib/admin-verify-deck';

/**
 * The verify deck (UX audit 2026-10-10, A-3 and A-12): a skip survives the
 * next decision, the counter counts each decision once, and «gone» asks first.
 */

const card = (id: string) => ({ id });
const ids = (cards: { id: string }[]) => cards.map((c) => c.id);

describe('arrangeDeck', () => {
  it('drops the cards decided here', () => {
    expect(ids(arrangeDeck([card('a'), card('b'), card('c')], new Set(['b']), []))).toEqual([
      'a',
      'c',
    ]);
  });

  it('keeps a skipped card at the back when the next batch arrives in name order', () => {
    // Skipped «a», then decided «b»: the revalidated batch is [a, c, d] again.
    expect(ids(arrangeDeck([card('a'), card('c'), card('d')], new Set(['b']), ['a']))).toEqual([
      'c',
      'd',
      'a',
    ]);
  });

  it('keeps the skipped ones in the order they were skipped', () => {
    expect(ids(arrangeDeck([card('a'), card('b'), card('c')], new Set(), ['c', 'a']))).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('forgets a skipped card that is no longer in the batch', () => {
    expect(ids(arrangeDeck([card('b')], new Set(), ['a']))).toEqual(['b']);
  });
});

describe('the deck', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'app/[locale]/admin/(protected)/verify/verify-deck.tsx'),
    'utf8',
  );

  it('subtracts only the decisions still in flight from the server count', () => {
    expect(source).toMatch(/remaining - inFlight/);
    expect(source).not.toMatch(/remaining - cleared/);
  });

  it('asks before marking a facility gone', () => {
    expect(source).toMatch(/decision === 'gone' && !window\.confirm\(t\('goneConfirm'\)\)/);
  });
});

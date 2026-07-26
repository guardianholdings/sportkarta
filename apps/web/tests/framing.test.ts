import { describe, expect, it } from 'vitest';

import bg from '../messages/bg.json';
import en from '../messages/en.json';
import denylist from '../lib/framing-denylist.json';

/**
 * ENGAGEMENT.md C7 — "showing up, not superiority", enforced rather than hoped for.
 *
 * The proposal's own evidence is that bragging framing BACKFIRES: Sezer/Gino/
 * Norton found humblebraggers are less liked and less trusted than plain
 * braggarts, and that people systematically overestimate how well their sharing
 * lands. For a platform whose subject is free public sport in a country where
 * 61% of adults never exercise, copy that tells a member they are better than
 * other members is off-message AND less effective.
 *
 * That rule is easy to state and easy to forget three sprints later, when
 * somebody writes a division promotion string at 6pm. So it is a test.
 *
 * SCOPE. Deliberately the ACHIEVEMENT and SHARE namespaces — the copy a member
 * reads about themselves, or pastes into a chat. `Leaderboard` and `Campaign`
 * are deliberately OUT of scope: those are ranking surfaces where "1st", "the
 * winner" and a rank number are simply facts, and a gate that forbade them
 * would be wrong rather than strict.
 *
 * Most of these namespaces do not exist yet — they arrive with the achievement
 * banner, Local Legend, divisions and the share sheet. Listing them now is the
 * point: the rule is in place BEFORE the copy is written, which is the only
 * time a framing rule is cheap.
 */

const GUARDED_NAMESPACES = [
  // Live today.
  'Badge',
  'Passport',
  'Points',
  'Checkin',
  'Contribute',
  // Arrive with the engagement work (docs/ENGAGEMENT-IMPLEMENTATION.md).
  'Achievement',
  'Legend',
  'Division',
  'Share',
  'Og',
  // The share sheet's captions and the story cards' copy (2026-07-26). These
  // are the words a member actually posts to Viber and Facebook, so they are
  // the single most load-bearing place the "showing up, not superiority" rule
  // applies — a caption is read by people who have never seen the product.
  'ShareSheet',
  'Story',
];

interface DenyEntry {
  token: string;
  stem: boolean;
  why: string;
}

const RULES: Record<string, DenyEntry[]> = {
  bg: denylist.bg as DenyEntry[],
  en: denylist.en as DenyEntry[],
};

/**
 * Word-boundary match. `stem: true` allows Bulgarian inflection to follow the
 * token but still requires it to START at a word boundary — calibration against
 * the live catalogue caught a naive substring match firing on "елит" inside
 * "Сателитен изглед", which is exactly the kind of confident nonsense that gets
 * a gate deleted instead of obeyed.
 */
function matcher(entry: DenyEntry): RegExp {
  const escaped = entry.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b is unreliable next to Cyrillic in some engines; assert a non-letter
  // (or string start) before the token instead.
  return new RegExp(`(^|[^\\p{L}])${escaped}${entry.stem ? '' : '(?![\\p{L}])'}`, 'iu');
}

function collectStrings(node: unknown, path: string, out: { path: string; text: string }[]): void {
  if (typeof node === 'string') {
    out.push({ path, text: node });
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      collectStrings(value, path ? `${path}.${key}` : key, out);
    }
  }
}

function guardedStrings(catalogue: Record<string, unknown>): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const ns of GUARDED_NAMESPACES) {
    if (!(ns in catalogue)) continue; // not built yet — nothing to check
    collectStrings(catalogue[ns], ns, out);
  }
  return out;
}

describe('C7 framing rule — showing up, not superiority', () => {
  it('the denylist is well-formed and reasoned', () => {
    for (const [locale, entries] of Object.entries(RULES)) {
      expect(entries.length, `${locale} denylist is empty`).toBeGreaterThan(0);
      for (const e of entries) {
        expect(e.token.length, `${locale}: empty token`).toBeGreaterThan(2);
        expect(
          e.why.length,
          `${locale}: token "${e.token}" needs a reason — an unexplained ban gets deleted`,
        ).toBeGreaterThan(15);
      }
    }
  });

  it('actually inspects some copy (guards a vacuous pass)', () => {
    // Every future namespace being absent is fine; ALL of them being absent
    // would mean the gate is checking nothing at all.
    expect(guardedStrings(bg as Record<string, unknown>).length).toBeGreaterThan(20);
  });

  for (const [locale, catalogue] of [
    ['bg', bg],
    ['en', en],
  ] as const) {
    it(`${locale}: no achievement or share copy frames a member as better than others`, () => {
      const offenses: string[] = [];
      for (const { path, text } of guardedStrings(catalogue as Record<string, unknown>)) {
        for (const entry of RULES[locale] ?? []) {
          if (matcher(entry).test(text)) {
            offenses.push(`  ${path}\n    "${text}"\n    ↳ "${entry.token}" — ${entry.why}`);
          }
        }
      }
      expect(
        offenses,
        'Achievement/share copy must be framed around showing up and belonging to a ' +
          'place, not around being better than other members (ENGAGEMENT.md C7). ' +
          'Ranking surfaces (Leaderboard, Campaign) are out of scope by design — if ' +
          'this fired on a factual rank, the string is probably in the wrong ' +
          'namespace:\n' +
          offenses.join('\n'),
      ).toEqual([]);
    });
  }

  it('the matcher is word-boundary aware (the "Сателитен" regression)', () => {
    const stem: DenyEntry = { token: 'елит', stem: true, why: 'test fixture for boundary matching' };
    expect(matcher(stem).test('Сателитен изглед')).toBe(false);
    expect(matcher(stem).test('елитен отбор')).toBe(true);
    const beat: DenyEntry = { token: 'beat', stem: true, why: 'test fixture for boundary matching' };
    expect(matcher(beat).test('a heartbeat monitor')).toBe(false);
    expect(matcher(beat).test('beat your rivals')).toBe(true);
  });
});

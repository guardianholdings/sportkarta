import { LAUNCH_BADGES } from '@sportkarta/lib/badges';
import { describe, expect, it } from 'vitest';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * Every badge in the catalogue has a name and a description, in both locales.
 *
 * WHY THIS DID NOT EXIST AND SHOULD HAVE. `lib/src/badges/catalog.ts` says in
 * its header that adding a badge is "one entry here plus two message keys", and
 * `components/passport/badge-grid.tsx` says the i18n parity test catches a
 * missing one. It does not: `tests/i18n.test.ts` only checks that bg and en have
 * the SAME keys, and that none is dotted. A badge added to the catalogue with no
 * message keys at all is symmetrically absent from both files, so parity is
 * satisfied and the suite stays green — and the failure appears at render, on a
 * member's passport, as a thrown next-intl error.
 *
 * B3a added four rungs at once, which is exactly the change that would have hit
 * it.
 *
 * This asserts the catalogue's own stated contract instead: one entry, two keys,
 * both locales.
 */

type Catalogue = Record<string, { name?: unknown; description?: unknown } | undefined>;

const CATALOGUES: [string, Catalogue][] = [
  ['bg', bg.Badge as Catalogue],
  ['en', en.Badge as Catalogue],
];

describe('badge catalogue ↔ messages', () => {
  it('there are badges to check (guards a vacuous pass)', () => {
    expect(LAUNCH_BADGES.length).toBeGreaterThan(5);
  });

  for (const [locale, messages] of CATALOGUES) {
    it(`${locale}: every badge has a name and a description`, () => {
      const missing: string[] = [];
      for (const badge of LAUNCH_BADGES) {
        const entry = messages[badge.slug];
        if (!entry) {
          missing.push(`${badge.slug} — no entry at all`);
          continue;
        }
        if (typeof entry.name !== 'string' || entry.name.trim() === '') {
          missing.push(`${badge.slug}.name`);
        }
        if (typeof entry.description !== 'string' || entry.description.trim() === '') {
          missing.push(`${badge.slug}.description`);
        }
      }
      expect(
        missing,
        `Badges in lib/src/badges/catalog.ts with no ${locale}.json copy. A badge ` +
          `without a name throws at render on a member's passport — and bg↔en parity ` +
          `does NOT catch it, because a badge missing from both files is symmetric:\n` +
          missing.map((m) => `  Badge.${m}`).join('\n'),
      ).toEqual([]);
    });
  }

  it('no orphan message entries for badges that no longer exist', () => {
    // The other direction: a badge removed from the catalogue leaves dead copy
    // that a translator will keep maintaining forever.
    //
    // Only per-badge ENTRIES count. The Badge namespace also holds flat UI
    // strings for the grid itself — `new`, `noneYet`, `progress` — which belong
    // to no slug and are not orphans. The shape is the discriminator: a badge
    // entry is an object with `name`, everything else is a string.
    const slugs = new Set(LAUNCH_BADGES.map((badge) => badge.slug));
    const entries = Object.entries(bg.Badge as Catalogue).filter(
      ([, value]) => typeof value === 'object' && value !== null && 'name' in value,
    );
    const orphans = entries.map(([key]) => key).filter((key) => !slugs.has(key));
    expect(
      orphans,
      `Badge copy with no catalogue entry — remove it or restore the badge:\n` +
        orphans.map((o) => `  Badge.${o}`).join('\n'),
    ).toEqual([]);
  });
});

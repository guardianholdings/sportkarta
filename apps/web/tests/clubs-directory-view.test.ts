import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { directoryView, showsApplyBox } from '../lib/clubs/directory-view';
import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * The /klubove list area: the clubs; «Няма клубове по тези критерии.» only
 * when a filter finds none while other clubs are published; and an invitation
 * to be the first club while none is published at all, on a filtered link
 * too (operator, 2026-11-01).
 */
describe('the directory view', () => {
  it('lists the clubs it found, without counting the rest', async () => {
    const countAll = vi.fn(async () => 5);
    expect(await directoryView(2, true, countAll)).toBe('clubs');
    expect(await directoryView(2, false, countAll)).toBe('clubs');
    expect(countAll).not.toHaveBeenCalled();
  });

  it('invites the first club when nothing is published and no filter is set', async () => {
    const countAll = vi.fn(async () => 0);
    expect(await directoryView(0, false, countAll)).toBe('emptyCatalogue');
    expect(countAll).not.toHaveBeenCalled();
  });

  it('says «no match» only when a filter finds none while other clubs exist', async () => {
    expect(await directoryView(0, true, async () => 3)).toBe('noMatch');
  });

  it('invites the first club on a filtered link too while nothing is published', async () => {
    expect(await directoryView(0, true, async () => 0)).toBe('emptyCatalogue');
  });
});

describe('the closing apply box', () => {
  // The invitation carries the same two buttons, so the box would repeat them
  // one screen lower (operator, 2026-11-02).
  it('is left out while the invitation shows', () => {
    expect(showsApplyBox('emptyCatalogue')).toBe(false);
  });

  it('stays below a list and below the no-match line', () => {
    expect(showsApplyBox('clubs')).toBe(true);
    expect(showsApplyBox('noMatch')).toBe(true);
  });

  it('is rendered only where showsApplyBox allows it', () => {
    const page = readFileSync(new URL('../app/[locale]/klubove/page.tsx', import.meta.url), 'utf8');
    expect(page).toMatch(
      /\{showsApplyBox\(view\) && \(\s*<section[^>]*>\s*<h2[^>]*>\{t\('applyTitle'\)\}/,
    );
    expect(page.split("t('applyTitle')")).toHaveLength(2);
  });
});

describe('the invitation has its words', () => {
  it.each([
    ['bg', bg.ClubPublic],
    ['en', en.ClubPublic],
  ])('%s', (_locale, words) => {
    expect(typeof words.emptyCatalogTitle).toBe('string');
    // The trial length comes from CLUB_TRIAL_DAYS, never typed (clubs-landing.test.ts).
    expect(words.emptyCatalogBody).toContain('{days}');
    // Its two buttons are the directory's own.
    expect(typeof words.apply).toBe('string');
    expect(typeof words.applyMore).toBe('string');
  });

  it('never ends a Bulgarian line on a one-letter word', () => {
    // A one-letter word (в, с, и …) is followed by a no-break space, so the
    // heading can wrap only after «клуб».
    for (const text of [bg.ClubPublic.emptyCatalogTitle, bg.ClubPublic.emptyCatalogBody]) {
      expect(text).not.toMatch(/(?<!\p{L})\p{L} /u);
    }
  });
});

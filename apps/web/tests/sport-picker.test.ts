import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import bg from '../messages/bg.json';

/**
 * One sports control (components/ui/sport-picker.tsx) on /dobavi, on the club
 * application and in the club's settings (UX audit 2026-10-31, V-32 and
 * DR-13): 44px chips in a wrapped row, no box scrolling inside the page, a
 * «Покажи всички» for a long list. Held at the source, as the vitest
 * environment has no DOM.
 */
const WEB = path.join(__dirname, '..');
const read = (...p: string[]) => readFileSync(path.join(WEB, ...p), 'utf8');

const picker = read('components', 'ui', 'sport-picker.tsx');
const forms = {
  '/dobavi': read('app', '[locale]', 'dobavi', 'add-facility-form.tsx'),
  '/klubove/zayavka': read('components', 'clubs', 'application-form.tsx'),
  '/klub/…/nastroyki': read('components', 'clubs', 'settings-forms.tsx'),
};

describe('SportPicker', () => {
  it('is a row of 44px chips that posts hidden inputs', () => {
    expect(picker).toMatch(/min-h-11/);
    expect(picker).toMatch(/type="hidden" name=\{name\}/);
    expect(picker).not.toMatch(/overflow-y-auto|max-h-/);
  });

  it('folds a long list behind «Покажи всички»', () => {
    expect(picker).toMatch(/visibleCount/);
    expect(picker).toMatch(/aria-expanded=\{expanded\}/);
  });
});

describe('every sports form uses it', () => {
  it.each(Object.entries(forms))('%s', (_where, src) => {
    expect(src).toMatch(/<SportPicker/);
    // The old pickers: a fixed-height box of checkbox rows, or hand-rolled chips.
    expect(src).not.toMatch(/max-h-56/);
    expect(src).not.toMatch(/name="sports"\s+value=\{sport\.value\}/);
  });

  it('has the expander words wherever a long list can appear', () => {
    for (const ns of ['ClubApply', 'ClubSettings', 'AddFacility'] as const) {
      const words = bg[ns] as Record<string, unknown>;
      expect(words.sportsShowAll, ns).toContain('{count}');
      expect(typeof words.sportsShowFewer, ns).toBe('string');
    }
  });
});

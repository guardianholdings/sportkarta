import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * The consent control of the whole passport, asserted at the source level.
 *
 * S-2 (UX audit 2026-10-10): while private, the panel said only «Паспортът ви е
 * личен», and the sentence about what becomes public — name and city on the
 * boards, campaigns and divisions — appeared only AFTER the one-tap «Направи
 * публичен». Consent explained after it is given is not consent explained.
 */
const panel = readFileSync(
  new URL('../components/passport/visibility-panel.tsx', import.meta.url),
  'utf8',
);

describe('the passport visibility panel', () => {
  it('states the consequences of publishing above the publish button, while private', () => {
    const consequences = panel.indexOf("t('visibilityPublishConsequences')");
    const button = panel.indexOf('<VisibilityForm');
    expect(consequences).toBeGreaterThan(0);
    expect(consequences).toBeLessThan(button);
    expect(panel).toMatch(
      /!visibility\.isPublic && \(\s*<p[^>]*>\{t\('visibilityPublishConsequences'\)\}/,
    );
  });

  it('says it in the future tense, naming what the boards will show', () => {
    expect(bg.Passport.visibilityPublishConsequences).toMatch(/^Ако го направите публичен/);
    expect(bg.Passport.visibilityPublishConsequences).toContain('класиранията');
    expect(en.Passport.visibilityPublishConsequences).toMatch(/^If you make it public/);
  });

  it('withholds the publish button from a member with no name (S-1)', () => {
    expect(panel).toMatch(/required: !visibility\.isPublic && !visibility\.hasName/);
  });
});

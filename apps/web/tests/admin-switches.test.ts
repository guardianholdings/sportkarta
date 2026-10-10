import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * One-tap nationwide switches ask first and name the consequence (UX audit
 * 2026-10-10, A-8): the paid-venue category (map, API, open data, tonight's
 * immutable dump), a partner's visibility (logo, ads and adoptions everywhere)
 * and an ad placement (a paid surface, for everyone, at once).
 */
const ADMIN = path.join(process.cwd(), 'app', '[locale]', 'admin', '(protected)');
const read = (...parts: string[]) => readFileSync(path.join(ADMIN, ...parts), 'utf8');

/** The JSX of the form that posts `action`, up to its closing tag. */
function formFor(source: string, action: string): string {
  const start = source.indexOf(`action={${action}`);
  expect(start, action).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('</form>', start));
}

describe('nationwide switches confirm first', () => {
  it('the paid-venue category', () => {
    const form = formFor(read('chastni', 'page.tsx'), 'setShowPaidAction');
    expect(form).toMatch(/<ConfirmButton/);
    expect(form).toMatch(/t\('disableConfirm'\) : t\('enableConfirm'\)/);
  });

  it("a partner's visibility", () => {
    const form = formFor(read('partnyori', 'page.tsx'), 'setVisibleAction');
    expect(form).toMatch(/<ConfirmButton/);
    expect(form).toMatch(/t\('hideConfirm'/);
    expect(form).toMatch(/t\('publishConfirm'/);
  });

  it('an ad placement going live or coming down', () => {
    const form = formFor(read('partnyori', 'placements-panel.tsx'), 'setPlacementVisibleAction');
    expect(form).toMatch(/<ConfirmButton/);
    expect(form).toMatch(/t\('adUnpublishConfirm'/);
    expect(form).toMatch(/t\('adPublishConfirm'/);
  });
});

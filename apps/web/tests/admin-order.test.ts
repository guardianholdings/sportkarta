import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Admin pickers list sports and surfaces in the reader's alphabetical order
 * (UX audit 2026-10-10, «order»): CANONICAL_SPORTS is ordered by its English
 * slugs, which on the Bulgarian admin reads as no order at all. And the one
 * irreversible campaign button keeps a visible focus ring (D-5).
 */
const ADMIN = path.join(process.cwd(), 'app', '[locale]', 'admin', '(protected)');
const read = (...parts: string[]) => readFileSync(path.join(ADMIN, ...parts), 'utf8');

describe('admin pickers are in reading order', () => {
  it.each([
    ['sesii', 'page.tsx'],
    ['kampanii', 'nova', 'page.tsx'],
    ['kampanii', '[slug]', 'page.tsx'],
    ['facilities', '[id]', 'page.tsx'],
  ])('%s/%s/%s sorts sports by their label', (...parts) => {
    expect(read(...parts.filter(Boolean))).toMatch(/inReadingOrder\(CANONICAL_SPORTS, locale,/);
  });

  it('the facility editor sorts surfaces too', () => {
    expect(read('facilities', '[id]', 'page.tsx')).toMatch(
      /inReadingOrder\(CANONICAL_SURFACES, locale,/,
    );
  });

  it('the campaign form shows the order it is given, not the slugs', () => {
    expect(read('kampanii', 'campaign-form.tsx')).not.toMatch(/CANONICAL_SPORTS/);
  });
});

describe('the close-campaign button', () => {
  it('uses the design-system button, focus ring included', () => {
    const form = read('kampanii', '[slug]', 'close-form.tsx');
    expect(form).toMatch(/className=\{buttonVariants\(\{ variant: 'danger' \}\)\}/);
    expect(form).not.toMatch(/shadow-xs disabled/);
  });
});

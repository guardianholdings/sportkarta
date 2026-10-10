import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Page titles, focus rings and the weekly index's empty state (UX audit
 * 2026-10-10, D-4, D-5, L-6), asserted at the source level.
 */
function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

describe('routes that had no title of their own (D-4)', () => {
  it.each([
    ['../app/[locale]/otmetka/[token]/page.tsx', "t('invalidHeading')"],
    ['../app/[locale]/sesiya/[occurrenceId]/roster/page.tsx', "t('signedUp')"],
    ['../app/[locale]/sedmitsata/otpisvane/[token]/page.tsx', "t('unsubscribeConfirmTitle')"],
  ])('%s sets a title, and stays noindex', (relative, titleKey) => {
    const page = source(relative);
    expect(page).toMatch(/export async function generateMetadata/);
    expect(page).toContain(`title: ${titleKey}`);
    expect(page).toMatch(/index: false, follow: false/);
    // Next refuses `metadata` and `generateMetadata` side by side.
    expect(page).not.toMatch(/export const metadata/);
  });
});

describe('list rows keep a visible focus ring (D-5)', () => {
  it.each(['../app/[locale]/sesii/page.tsx', '../app/[locale]/sedmitsata/page.tsx'])(
    '%s restates the ring its shadow utility would erase',
    (relative) => {
      const page = source(relative);
      const rowLink = /className="flex items-center gap-3 rounded-card[^"]*"/.exec(page)?.[0] ?? '';
      expect(rowLink).toContain('shadow-sm');
      expect(rowLink).toContain('focus-visible:shadow-[var(--ring)]');
    },
  );
});

describe('the weekly index on an empty week (L-6)', () => {
  it('says «choose a city» only above a list of cities', () => {
    const page = source('../app/[locale]/sedmitsata/page.tsx');
    expect(page).toMatch(/\{rows\.length > 0 && \(\s*<p[^>]*>\{t\('indexIntro'\)\}/);
  });
});

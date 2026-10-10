import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { formatMonthYear } from '@/lib/format';

/**
 * Dates on the passport and training surfaces go through lib/format (UX audit
 * 2026-10-10, S-15): an ad-hoc `Intl.DateTimeFormat(locale)` printed the
 * SERVER's calendar day (the process runs in UTC on purpose) in US order for
 * `en`, and a raw `YYYY-MM` reached readers as «В POPS от 2026-08».
 */
const surfaces = [
  '../components/passport/history-list.tsx',
  '../components/passport/badge-grid.tsx',
  '../app/[locale]/pasport/[handle]/page.tsx',
  '../app/og/lichen/[locale]/pasport/[handle]/card.png/route.tsx',
  '../app/[locale]/trenirovki/page.tsx',
];

describe('date surfaces', () => {
  it.each(surfaces)('%s formats through lib/format, never its own Intl formatter', (relative) => {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
    expect(source).toMatch(/from '@\/lib\/format'/);
    expect(source).not.toMatch(/new Intl\.DateTimeFormat/);
  });

  it('prints a member-since month as words', () => {
    // What the public passport subtitle and the OG card now say.
    expect(formatMonthYear('2026-10', 'bg')).toBe('октомври 2026 г.');
    expect(formatMonthYear('2026-10', 'en')).toBe('October 2026');
  });
});

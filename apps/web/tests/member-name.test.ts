import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { hasDisplayName, memberName } from '@/lib/member-name';

/**
 * Members with no display name (UX audit 2026-10-10, S-1).
 *
 * An email-code sign-up creates the account with `display_name = ''` — the
 * column is NOT NULL DEFAULT '' — so every `displayName ?? fallback` in the
 * product was dead code for exactly the members it was written for: blank
 * roster rows, empty links on the boards, an empty <h1> on a public passport.
 */

describe('memberName', () => {
  it('falls back for an empty or whitespace-only name, not only for null', () => {
    for (const name of ['', '   ', null, undefined]) {
      expect(memberName(name, 'Участник без име'), String(name)).toBe('Участник без име');
    }
  });

  it('renders a real name', () => {
    expect(memberName('Мария', 'x')).toBe('Мария');
    expect(memberName('  Мария ', 'x')).toBe('Мария');
  });
});

describe('hasDisplayName', () => {
  it('is the same question memberName asks', () => {
    expect(hasDisplayName('')).toBe(false);
    expect(hasDisplayName('  ')).toBe(false);
    expect(hasDisplayName(null)).toBe(false);
    expect(hasDisplayName('Иван')).toBe(true);
  });
});

/**
 * Every surface that prints a member's name goes through the fallback. A raw
 * `{entry.displayName}` in JSX is how the blank rows happened, so it is
 * asserted absent rather than trusted to review.
 */
describe('name-rendering surfaces', () => {
  const surfaces = [
    '../components/passport/leaderboard-table.tsx',
    '../components/passport/participation-table.tsx',
    '../components/passport/division-ladder.tsx',
    '../components/campaigns/campaign-standings.tsx',
    '../app/[locale]/pasport/[handle]/page.tsx',
    '../app/og/lichen/[locale]/pasport/[handle]/card.png/route.tsx',
  ];

  it.each(surfaces)('%s never renders a bare display name', (relative) => {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
    expect(source).toContain('memberName(');
    expect(source).not.toMatch(/\{\s*(?:entry|row|passport)\.displayName\s*\}/);
    expect(source).not.toMatch(/title: share\.displayName/);
  });
});

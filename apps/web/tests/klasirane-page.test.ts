import { readFileSync } from 'node:fs';

import { renderSql, type SQL } from '@sportkarta/db';
import { describe, expect, it } from 'vitest';

import { ownVisibility } from '@/lib/passport';

/**
 * /klasirane's loose ends (UX audit 2026-10-10, S-6 and S-18), asserted at the
 * source level; the queries behind the boards are tested in leaderboard.test.ts.
 */
const page = readFileSync(new URL('../app/[locale]/klasirane/page.tsx', import.meta.url), 'utf8');

describe('your standing (S-6)', () => {
  it('tells a PUBLIC member with no points that, not to publish again', () => {
    expect(page).toMatch(
      /!standing && visibility\?\.isPublic && \([\s\S]*?t\('standingNoPoints'\)/,
    );
    expect(page).toMatch(
      /!standing && !visibility\?\.isPublic && \([\s\S]*?t\('standingNotPublic'\)/,
    );
  });

  it('reads visibility from the database, and hands out no handle while private', async () => {
    const rows = (visibility: string) => [
      { profile_visibility: visibility, public_handle: 'd'.repeat(24), has_name: true },
    ];
    const db = (visibility: string) => ({
      statements: [] as string[],
      execute(query: SQL) {
        this.statements.push(renderSql(query).sql);
        return Promise.resolve({ rows: rows(visibility) });
      },
    });
    expect(await ownVisibility(db('public'), 'u1')).toEqual({
      isPublic: true,
      handle: 'd'.repeat(24),
    });
    // A retained handle from an earlier publication must not mark a row.
    expect(await ownVisibility(db('private'), 'u1')).toEqual({ isPublic: false, handle: null });
  });
});

describe('board loose ends (S-18)', () => {
  it('makes the signed-out line a sign-in link that returns to this board', () => {
    expect(page).toMatch(/href=\{signInHref\(boardHref\)\}[\s\S]{0,120}t\('standingSignedOut'\)/);
  });

  it('puts the period control in the board it changes, not above both', () => {
    const nav = /<nav[\s\S]*?<\/nav>/.exec(page)?.[0] ?? '';
    expect(nav).not.toContain("t('filterPeriodLabel')");
    const contributions = page.indexOf("t('contributionsSectionTitle')");
    const period = page.indexOf("t('filterPeriodLabel')");
    expect(period).toBeGreaterThan(contributions);
    expect(period).toBeLessThan(page.indexOf('<LeaderboardTable'));
  });

  it("marks the viewer's own row on both boards", () => {
    expect(page).toMatch(
      /<ParticipationTable entries=\{participation\} highlightHandle=\{ownHandle\}/,
    );
    expect(page).toMatch(/<LeaderboardTable entries=\{entries\} highlightHandle=\{ownHandle\}/);
  });
});

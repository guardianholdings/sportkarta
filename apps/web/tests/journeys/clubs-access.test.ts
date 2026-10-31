import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { getDb, sql } from '@sportkarta/db';
import {
  CLUB_TIERS,
  CLUB_TRIAL_DAYS,
  addDaysIso,
  canWrite,
  clubAccessState,
  type ClubStatus,
  type ClubTier,
  type IsoDate,
} from '@sportkarta/lib/clubs';
import { afterAll, describe, expect, it } from 'vitest';

import { clubWritableSql, SOFIA_TODAY_SQL } from '@/lib/clubs/access';
import { approveClub } from '@/lib/clubs/admin';
import { applyForClub } from '@/lib/clubs/apply';

import { closePool, hasDb, journey, makeUser, one } from './db';

/**
 * The write rule exists twice — `clubAccessState`/`canWrite` in TypeScript for
 * the banners and the detail pages, `clubWritableSql` in SQL inside every
 * statement — and the two must agree on every date. Every tier is paid
 * (operator decision 2026-10-31, migration 0060): no tier may write without a
 * trial or a payment, and a club with neither is a plain FALSE, never NULL
 * (`NOT clubWritableSql()` is the admin's «Изтекли» tab, and NULL would drop
 * the club from every tab).
 */

const OFFSETS = [null, -20, -15, -14, -1, 0, 1, 30] as const;
const STATUSES: ClubStatus[] = ['active', 'suspended', 'pending'];

describe.skipIf(!hasDb)('club access rule, TypeScript and SQL (requires running database)', () => {
  afterAll(closePool);

  it('agrees on every tier, status and pair of dates, and is never NULL', async () => {
    const db = getDb();
    const todayRow = await db.execute(sql`SELECT to_char(${SOFIA_TODAY_SQL}, 'YYYY-MM-DD') AS d`);
    const today = String(todayRow.rows[0]?.d) as IsoDate;
    const at = (offset: number | null) => (offset === null ? null : addDaysIso(today, offset));

    const cases: {
      status: ClubStatus;
      tier: ClubTier;
      trial: IsoDate | null;
      paid: IsoDate | null;
    }[] = [];
    for (const status of STATUSES)
      for (const tier of CLUB_TIERS)
        for (const trial of OFFSETS)
          for (const paid of OFFSETS)
            cases.push({ status, tier, trial: at(trial), paid: at(paid) });

    const rows = cases.map(
      (c, i) =>
        sql`(${c.status}::text, ${c.tier}::text, ${c.trial}::date, ${c.paid}::date, ${i}::int)`,
    );
    const result = await db.execute(sql`
      SELECT c.i, ${clubWritableSql('c')} AS writable
        FROM (VALUES ${sql.join(rows, sql`, `)}) AS c(status, tier, trial_ends_on, paid_until, i)
       ORDER BY c.i
    `);
    expect(result.rows).toHaveLength(cases.length);
    for (const row of result.rows) {
      const c = cases[Number(row.i)];
      if (!c) throw new Error('case');
      const expected = canWrite(
        clubAccessState(
          { status: c.status, tier: c.tier, trialEndsOn: c.trial, paidUntil: c.paid },
          today,
        ),
      );
      expect(row.writable, JSON.stringify(c)).toBe(expected);
    }
  });

  it('starts the trial when a community club is approved, as on every tier', async () => {
    await journey(async (tx) => {
      const owner = await makeUser(tx, 'tier_owner');
      const admin = await makeUser(tx, 'tier_admin', 'admin');
      const applied = await applyForClub(tx, owner, {
        nameBg: `E2E Общност ${Math.random().toString(36).slice(2, 6)}`,
        kind: 'trainer',
        tier: 'community',
        municipalityId: null,
        sports: ['yoga'],
        websiteUrl: null,
        descriptionBg: null,
      });
      expect(applied.ok).toBe(true);
      if (!applied.ok) return;
      const before = await one<{ writable: boolean }>(
        tx,
        sql`SELECT ${clubWritableSql('c')} AS writable FROM clubs c WHERE c.id = ${applied.clubId}::uuid`,
      );
      expect(before?.writable).toBe(false);

      expect(await approveClub(tx, admin, applied.clubId)).toBe(true);
      const after = await one<{ trial: string; expected: string; writable: boolean }>(
        tx,
        sql`SELECT to_char(c.trial_ends_on, 'YYYY-MM-DD') AS trial,
                   to_char(${SOFIA_TODAY_SQL} + ${CLUB_TRIAL_DAYS}::int, 'YYYY-MM-DD') AS expected,
                   ${clubWritableSql('c')} AS writable
              FROM clubs c WHERE c.id = ${applied.clubId}::uuid`,
      );
      expect(after?.trial).toBe(after?.expected);
      expect(after?.writable).toBe(true);
    });
  });
});

/**
 * The old bypass was `tier = 'community' OR …`, copied into nine statements.
 * Pin its absence across every package that writes SQL, so restoring it in
 * one forgotten copy fails here rather than shipping a free tier.
 */
describe('no statement treats a tier as free', () => {
  const ROOTS = [
    'lib',
    'app',
    'components',
    '../../db/src',
    '../../apps/worker/src',
    '../../lib/src',
  ];
  const FREE_TIER = /tier\s*(=|<>|!=)\s*'community'/;

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sources(full);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
  }

  it('has no tier = community clause anywhere outside the tests', () => {
    const offenders = ROOTS.flatMap((root) => sources(path.join(process.cwd(), root))).filter(
      (file) => FREE_TIER.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

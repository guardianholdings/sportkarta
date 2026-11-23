import { CLUB_ROLES, addDaysIso, sofiaToday, type IsoDate } from '@sportkarta/lib/clubs';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  clubLifecycleCandidates,
  clubMonthFigures,
  clubWeekFigures,
  dueClubReminders,
  expiryCandidates,
  memberRecipient,
  operatorRecipients,
  recordClubMonthlyActivity,
  staffRecipients,
  trainerClassesOn,
} from './clubs/mail.js';
import {
  DEMO_CLUB_SLUG,
  DEMO_CLUB_STATUS,
  DEMO_STAFF,
  DemoClubRefusal,
  countRowsByTable,
  purgeDemoClub,
  seedDemoClub,
  type DemoPurgeReport,
} from './clubs/demo-seed.js';
import { cleanupClubFixtures, makeClub } from './clubs/test-fixtures.js';
import { digestRecipients } from './digest.js';

/**
 * The shared, view-only demo club's writers (the seed, the weekly refresh and
 * the purge):
 *
 *   * a rebuild changes no table's row count and never touches a `users` row:
 *     the three staff accounts keep their ids and row versions;
 *   * both writers refuse, with nothing written, unless no club or exactly one
 *     club has the demo slug or status and that one has both;
 *   * the purge removes the demo club, every row reached from its id and its
 *     three staff accounts, prints those counts before COMMIT, and nothing else;
 *   * no mail selection reaches it: the three staff accounts are unverified
 *     and in no staff, operator, trainer or digest list, the club is in no
 *     club-level list, no made-up member resolves to an address, and the
 *     monthly activity record skips it.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL,
 * and skips when a demo club is there already, so it never purges one it did
 * not make.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const STAFF_IDS = DEMO_STAFF.map((s) => s.id);

describe.skipIf(!hasDb)('demo club seed and purge (requires running database)', () => {
  let client: pg.Client;
  let pool: pg.Pool;
  let preexisting = true;

  async function demoClubs(): Promise<number> {
    const r = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM clubs WHERE slug = $1 OR status = $2`,
      [DEMO_CLUB_SLUG, DEMO_CLUB_STATUS],
    );
    return Number(r.rows[0]?.n ?? '0');
  }

  async function staffRows(): Promise<string[]> {
    const r = await client.query<{ row: string }>(
      `SELECT id || ':' || xmin::text AS row FROM users WHERE id = ANY($1::text[]) ORDER BY id`,
      [STAFF_IDS],
    );
    return r.rows.map((x) => x.row);
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    preexisting = (await demoClubs()) > 0;
  });

  afterAll(async () => {
    if (!preexisting) {
      await client.query(
        `UPDATE clubs SET slug = 'e2e-demo-slug' WHERE slug = $1 AND status <> $2`,
        [DEMO_CLUB_SLUG, DEMO_CLUB_STATUS],
      );
      await client.query(
        `UPDATE clubs SET status = 'active' WHERE slug LIKE 'e2e-%' AND status = $1`,
        [DEMO_CLUB_STATUS],
      );
      if ((await demoClubs()) > 0) await purgeDemoClub(pool);
      await cleanupClubFixtures(client);
    }
    await pool.end();
    await client.end();
  });

  it('a rebuild changes no row count and never touches a users row', async (ctx) => {
    if (preexisting) ctx.skip();
    const first = await seedDemoClub(pool);
    expect(first.staffInserted).toBe(DEMO_STAFF.length);
    expect(first.removed).toEqual({});
    const countsBefore = await countRowsByTable(client);
    const staffBefore = await staffRows();
    expect(staffBefore).toHaveLength(DEMO_STAFF.length);

    const again = await seedDemoClub(pool);
    expect(again.staffInserted).toBe(0);
    expect(again.removed).toEqual(again.written);
    expect(again.written).toEqual(first.written);
    expect('users' in again.removed || 'users' in again.written).toBe(false);
    expect(await countRowsByTable(client)).toEqual(countsBefore);
    expect(await staffRows()).toEqual(staffBefore);
  });

  it('refuses, with nothing written, while a second club has the demo status', async (ctx) => {
    if (preexisting) ctx.skip();
    const other = await makeClub(client, 'demo-second', { status: DEMO_CLUB_STATUS });
    const counts = await countRowsByTable(client);
    const staff = await staffRows();
    await expect(seedDemoClub(pool)).rejects.toBeInstanceOf(DemoClubRefusal);
    await expect(purgeDemoClub(pool)).rejects.toBeInstanceOf(DemoClubRefusal);
    expect(await countRowsByTable(client)).toEqual(counts);
    expect(await staffRows()).toEqual(staff);
    await client.query(`UPDATE clubs SET status = 'active' WHERE id = $1`, [other.clubId]);
    await cleanupClubFixtures(client);
  });

  it('no mail selection reaches the demo club, its members or its three staff accounts', async (ctx) => {
    if (preexisting) ctx.skip();
    const db = drizzle(pool);
    const club = await client.query<{ id: string }>(
      `SELECT id FROM clubs WHERE slug = $1 AND status = $2`,
      [DEMO_CLUB_SLUG, DEMO_CLUB_STATUS],
    );
    const clubId = club.rows[0]?.id ?? '';
    expect(clubId).not.toBe('');
    const staff = new Set(STAFF_IDS);
    const ofDemo = <T extends { clubId: string }>(rows: readonly T[]): T[] =>
      rows.filter((row) => row.clubId === clubId);
    const ofStaff = <T extends { userId: string }>(rows: readonly T[]): T[] =>
      rows.filter((row) => staff.has(row.userId));

    // Staff and operator mail goes to verified addresses only; these are not.
    const verified = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE id = ANY($1::text[]) AND email_verified`,
      [STAFF_IDS],
    );
    expect(verified.rows[0]?.n).toBe(0);
    expect(await staffRecipients(db, clubId, CLUB_ROLES)).toEqual([]);
    expect(ofStaff(await operatorRecipients(db))).toEqual([]);
    expect(ofStaff(await digestRecipients(db))).toEqual([]);

    // Every club-level selection takes active clubs only; `demo` is not one.
    const today = sofiaToday();
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
    const monday = addDaysIso(today, -((weekday + 6) % 7));
    const month = `${today.slice(0, 7)}-01` as IsoDate;
    for (let day = 0; day < 7; day += 1) {
      const classes = await trainerClassesOn(db, addDaysIso(today, day));
      expect(ofDemo(classes)).toEqual([]);
      expect(ofStaff(classes)).toEqual([]);
    }
    expect(ofDemo(await dueClubReminders(db))).toEqual([]);
    expect(ofDemo(await expiryCandidates(db, 'membership_expiring', today))).toEqual([]);
    expect(ofDemo(await expiryCandidates(db, 'membership_expired', today))).toEqual([]);
    expect(ofDemo(await clubLifecycleCandidates(db, today))).toEqual([]);
    expect(ofDemo(await clubWeekFigures(db, monday))).toEqual([]);
    expect(ofDemo(await clubMonthFigures(db, month))).toEqual([]);

    // No made-up member resolves to an address.
    const members = await client.query<{ id: string }>(
      `SELECT id FROM club_members WHERE club_id = $1::uuid ORDER BY id`,
      [clubId],
    );
    expect(members.rows.length).toBeGreaterThan(0);
    for (const member of members.rows) {
      expect(await memberRecipient(db, clubId, member.id)).toBeNull();
    }

    // And the monthly activity record (what the operator invoices from) skips
    // it. Run in a transaction that is rolled back, so the table is unchanged.
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await recordClubMonthlyActivity(drizzle(tx), month);
      const rows = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM club_monthly_activity WHERE club_id = $1::uuid`,
        [clubId],
      );
      expect(rows.rows[0]?.n).toBe(0);
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });

  it('the purge removes the club, its rows and its three staff accounts, and nothing else', async (ctx) => {
    if (preexisting) ctx.skip();
    const before = await countRowsByTable(client);
    let seen: DemoPurgeReport | null = null;
    const report = await purgeDemoClub(pool, {
      beforeCommit: (r) => {
        seen = r;
      },
    });
    expect(seen).toEqual(report);
    expect(report.removed.users).toBe(DEMO_STAFF.length);
    expect(report.removed.clubs).toBe(1);
    const after = await countRowsByTable(client);
    for (const [table, n] of before) {
      expect([table, n - (after.get(table) ?? 0)]).toEqual([table, report.removed[table] ?? 0]);
    }
    expect(await demoClubs()).toBe(0);
    expect(await staffRows()).toEqual([]);
    await expect(purgeDemoClub(pool)).rejects.toBeInstanceOf(DemoClubRefusal);
  });

  it('refuses while the demo slug belongs to a club that is not the demo club', async (ctx) => {
    if (preexisting) ctx.skip();
    const holder = await makeClub(client, 'demo-slug');
    await client.query(`UPDATE clubs SET slug = $1 WHERE id = $2`, [DEMO_CLUB_SLUG, holder.clubId]);
    const counts = await countRowsByTable(client);
    await expect(seedDemoClub(pool)).rejects.toBeInstanceOf(DemoClubRefusal);
    await expect(purgeDemoClub(pool)).rejects.toBeInstanceOf(DemoClubRefusal);
    expect(await countRowsByTable(client)).toEqual(counts);
    expect(await staffRows()).toEqual([]);
    await client.query(`UPDATE clubs SET slug = 'e2e-demo-slug' WHERE id = $1`, [holder.clubId]);
    await cleanupClubFixtures(client);
  });
});

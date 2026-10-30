import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from './client.js';
import { pruneClubRetention } from './clubs/retention.js';
import {
  cleanupClubFixtures,
  makeClub,
  makeMember,
  makePlan,
  type ClubFixture,
} from './clubs/test-fixtures.js';

/**
 * What the club module forgets, and what it keeps (db/src/clubs/retention.ts):
 * a checkout that never carried money, 90 days on; a staff invitation that
 * is over, 30 days on; a notice about a date that has passed, a year on —
 * and nothing else: a paid checkout (the refund path's link to the account),
 * a live invitation, a notice whose key may recur.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('club retention prune (requires running database)', () => {
  let client: pg.Client;
  let club: ClubFixture;
  let memberId: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await cleanupClubFixtures(client);
    await client.end();
  });

  beforeEach(async () => {
    await cleanupClubFixtures(client);
    club = await makeClub(client, 'retention', { tier: 'community' });
    memberId = await makeMember(client, club.clubId, 'Мария');
  });

  async function checkout(status: string, ageDays: number): Promise<string> {
    const row = await client.query<{ id: string }>(
      `INSERT INTO club_checkouts (club_id, purpose, member_id, plan_id, starts_on, amount_cents,
                                   provider, account_ref, status, completed_at, payment_ref,
                                   created_at)
       SELECT $1, 'membership', $2, p.id, current_date, 4500, 'fake', 'acct_test_retention',
              $3, CASE WHEN $3 = 'open' THEN NULL ELSE now() END,
              CASE WHEN $3 = 'paid' THEN 'pi_test_kept' END, now() - make_interval(days => $4)
         FROM club_plans p WHERE p.club_id = $1 LIMIT 1
       RETURNING id`,
      [club.clubId, memberId, status, ageDays],
    );
    return row.rows[0]?.id ?? '';
  }

  async function invite(resolvedDaysAgo: number | null): Promise<string> {
    const row = await client.query<{ id: string }>(
      `INSERT INTO club_staff_invites (club_id, email, role, token_hash, expires_at, accepted_at)
       VALUES ($1, 'invitee@example.org', 'trainer', encode(sha256(gen_random_uuid()::text::bytea), 'hex'),
               now() + interval '14 days',
               CASE WHEN $2::int IS NULL THEN NULL ELSE now() - make_interval(days => $2::int) END)
       RETURNING id`,
      [club.clubId, resolvedDaysAgo],
    );
    return row.rows[0]?.id ?? '';
  }

  async function notice(kind: string, ageDays: number): Promise<string> {
    const row = await client.query<{ id: string }>(
      `INSERT INTO club_notifications (club_id, member_id, kind, dedupe_key, sent_at)
       VALUES ($1, $2, $3, $3 || ':' || $4::int::text, now() - make_interval(days => $4::int))
       RETURNING id`,
      [club.clubId, memberId, kind, ageDays],
    );
    return row.rows[0]?.id ?? '';
  }

  async function exists(table: string, id: string): Promise<boolean> {
    const row = await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    return row.rows.length > 0;
  }

  it('forgets dead checkouts, resolved invitations and dated notices — and nothing else', async () => {
    await makePlan(client, club.clubId, { priceCents: 4500 });
    const deadOpen = await checkout('open', 100);
    const deadExpired = await checkout('expired', 100);
    const freshExpired = await checkout('expired', 10);
    const paid = await checkout('paid', 400);
    const resolved = await invite(40);
    const recent = await invite(5);
    const live = await invite(null);
    const oldReminder = await notice('reminder_24h', 400);
    const youngReminder = await notice('reminder_24h', 100);
    const oldExpiring = await notice('membership_expiring', 400);

    expect(await pruneClubRetention(getDb())).toEqual({
      checkouts: 2,
      staffInvites: 1,
      notifications: 1,
    });

    expect(await exists('club_checkouts', deadOpen)).toBe(false);
    expect(await exists('club_checkouts', deadExpired)).toBe(false);
    expect(await exists('club_checkouts', freshExpired)).toBe(true);
    expect(await exists('club_checkouts', paid)).toBe(true);
    expect(await exists('club_staff_invites', resolved)).toBe(false);
    expect(await exists('club_staff_invites', recent)).toBe(true);
    expect(await exists('club_staff_invites', live)).toBe(true);
    expect(await exists('club_notifications', oldReminder)).toBe(false);
    expect(await exists('club_notifications', youngReminder)).toBe(true);
    expect(await exists('club_notifications', oldExpiring)).toBe(true);

    // A second run finds nothing more to forget.
    expect(await pruneClubRetention(getDb())).toEqual({
      checkouts: 0,
      staffInvites: 0,
      notifications: 0,
    });
  });
});

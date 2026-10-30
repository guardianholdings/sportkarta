import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from './client.js';
import {
  claimClubNotification,
  clubLifecycleCandidates,
  expiryCandidates,
  memberRecipient,
  recordClubMonthlyActivity,
} from './clubs/mail.js';
import {
  cleanupClubFixtures,
  ensureUser,
  makeClub,
  makeMember,
  makePlan,
  sellMembership,
  type ClubFixture,
} from './clubs/test-fixtures.js';

/**
 * Who club mail reaches (db/src/clubs/mail.ts) — the rules the worker relies
 * on and cannot re-derive:
 *
 *   * a linked member at their POPS address, unless they switched club mail off;
 *   * an unlinked record only on the club's instruction, never after an opt-out;
 *   * a minor never — the guardian's record by the same rules, or nobody;
 *   * a club that is not active mails no member;
 *   * the ledger claims once per key, and the monthly figures freeze once.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('club mail recipients (requires running database)', () => {
  let client: pg.Client;
  let club: ClubFixture;

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
    club = await makeClub(client, 'mail');
  });

  async function link(memberId: string, label: string, notify = true): Promise<string> {
    const userId = await ensureUser(client, label);
    await client.query(
      `INSERT INTO club_member_links (member_id, club_id, user_id, status, method, notify_email)
       VALUES ($1, $2, $3, 'active', 'invite', $4)`,
      [memberId, club.clubId, userId, notify],
    );
    return userId;
  }

  it('mails a linked member at their account address, and not once they turn it off', async () => {
    const memberId = await makeMember(client, club.clubId, 'Свързан', {
      email: 'club-record@example.org',
    });
    const userId = await link(memberId, 'linked');
    expect(await memberRecipient(getDb(), club.clubId, memberId)).toMatchObject({
      email: `e2e_club_linked@example.org`,
      linked: true,
      unsubscribeToken: null,
    });
    await client.query(`UPDATE club_member_links SET notify_email = false WHERE user_id = $1`, [
      userId,
    ]);
    expect(await memberRecipient(getDb(), club.clubId, memberId)).toBeNull();
  });

  it('mails an unlinked record only on the club’s instruction, and never after an opt-out', async () => {
    const memberId = await makeMember(client, club.clubId, 'Без профил', {
      email: 'walkin@example.org',
    });
    // Off by default: the club has not told us to mail people without accounts.
    expect(await memberRecipient(getDb(), club.clubId, memberId)).toBeNull();
    await client.query(`UPDATE clubs SET mail_unlinked_members = true WHERE id = $1`, [
      club.clubId,
    ]);
    const recipient = await memberRecipient(getDb(), club.clubId, memberId);
    expect(recipient).toMatchObject({ email: 'walkin@example.org', linked: false });
    expect(recipient?.unsubscribeToken).toMatch(/^[0-9a-f]{32}$/);
    await client.query(`UPDATE club_members SET email_opt_out_at = now() WHERE id = $1`, [
      memberId,
    ]);
    expect(await memberRecipient(getDb(), club.clubId, memberId)).toBeNull();
  });

  it('never addresses a minor: the guardian receives it, or nobody does', async () => {
    const guardian = await makeMember(client, club.clubId, 'Родител');
    const child = await makeMember(client, club.clubId, 'Дете', {
      email: 'child@example.org',
      isMinor: true,
      guardianId: guardian,
    });
    // The guardian has no account and the club mails nobody unlinked: silence,
    // even though the child's record carries an address.
    expect(await memberRecipient(getDb(), club.clubId, child)).toBeNull();
    await link(guardian, 'guardian');
    expect(await memberRecipient(getDb(), club.clubId, child)).toMatchObject({
      email: 'e2e_club_guardian@example.org',
      aboutName: 'Дете',
      targetMemberId: guardian,
    });
    const orphan = await makeMember(client, club.clubId, 'Без родител', {
      email: 'orphan@example.org',
      isMinor: true,
    });
    await client.query(`UPDATE clubs SET mail_unlinked_members = true WHERE id = $1`, [
      club.clubId,
    ]);
    expect(await memberRecipient(getDb(), club.clubId, orphan)).toBeNull();
  });

  it('mails nobody at a suspended club', async () => {
    const memberId = await makeMember(client, club.clubId, 'Член');
    await link(memberId, 'suspended');
    await client.query(
      `UPDATE clubs SET status = 'suspended', suspended_at = now() WHERE id = $1`,
      [club.clubId],
    );
    expect(await memberRecipient(getDb(), club.clubId, memberId)).toBeNull();
  });

  it('claims a ledger key once', async () => {
    const memberId = await makeMember(client, club.clubId, 'Веднъж');
    const claim = () =>
      claimClubNotification(getDb(), {
        clubId: club.clubId,
        memberId,
        kind: 'reminder_24h',
        key: `reminder_24h:${memberId}:${memberId}`,
      });
    expect(await claim()).toBe(true);
    expect(await claim()).toBe(false);
  });

  it('offers an expiry notice once per abonnement, and not after a renewal', async () => {
    const memberId = await makeMember(client, club.clubId, 'Изтича');
    const planId = await makePlan(client, club.clubId);
    const { membershipId } = await sellMembership(client, club.clubId, memberId, planId, {
      startOffsetDays: -25,
      days: 30,
    });
    const today = (
      await client.query<{ d: string }>(
        `SELECT to_char((now() AT TIME ZONE 'Europe/Sofia')::date, 'YYYY-MM-DD') AS d`,
      )
    ).rows[0]?.d as string;
    const before = await expiryCandidates(getDb(), 'membership_expiring', today);
    expect(before.map((c) => c.membershipId)).toContain(membershipId);
    await claimClubNotification(getDb(), {
      clubId: club.clubId,
      memberId,
      kind: 'membership_expiring',
      key: `membership_expiring:${membershipId}`,
    });
    const after = await expiryCandidates(getDb(), 'membership_expiring', today);
    expect(after.map((c) => c.membershipId)).not.toContain(membershipId);

    const other = await makeMember(client, club.clubId, 'Поднови');
    const first = await sellMembership(client, club.clubId, other, planId, {
      startOffsetDays: -25,
      days: 30,
    });
    await sellMembership(client, club.clubId, other, planId, { startOffsetDays: 5, days: 30 });
    const renewed = await expiryCandidates(getDb(), 'membership_expiring', today);
    expect(renewed.map((c) => c.membershipId)).not.toContain(first.membershipId);
  });

  it('lists a paying club’s milestones once each, and a community club never', async () => {
    const paying = await makeClub(client, 'standing', { tier: 'standard' });
    const dbToday = String(
      (await client.query<{ d: string }>(`SELECT current_date::text AS d`)).rows[0]?.d,
    );
    const set = (assignment: string) =>
      client.query(`UPDATE clubs SET ${assignment} WHERE id = $1`, [paying.clubId]);
    const mine = async () =>
      (await clubLifecycleCandidates(getDb(), dbToday)).filter((c) => c.clubId === paying.clubId);
    await set(`trial_ends_on = current_date + 7, paid_until = NULL`);
    expect(await mine()).toEqual([
      {
        kind: 'club_trial_ending',
        clubId: paying.clubId,
        date: expect.any(String),
        anchor: expect.stringMatching(/:7$/),
      },
    ]);
    // Paid past the trial: no warning about the trial.
    await set(`paid_until = current_date + 60`);
    expect(await mine()).toEqual([]);
    await set(`trial_ends_on = current_date - 30, paid_until = current_date - 1`);
    expect((await mine()).map((c) => c.kind)).toEqual(['club_past_due']);
    await set(`paid_until = current_date - 15`);
    expect((await mine()).map((c) => c.kind)).toEqual(['club_lapsed']);
    await set(`status = 'suspended', suspended_at = now()`);
    expect((await mine()).map((c) => c.kind)).toEqual(['club_suspended']);
    await set(`tier = 'community', status = 'active', suspended_at = NULL`);
    expect(await mine()).toEqual([]);
  });

  it('freezes a month of activity once', async () => {
    // A club that applied this month has no row for last month; this one is older.
    await client.query(`UPDATE clubs SET applied_at = now() - interval '90 days' WHERE id = $1`, [
      club.clubId,
    ]);
    const memberId = await makeMember(client, club.clubId, 'Активен');
    const planId = await makePlan(client, club.clubId);
    await sellMembership(client, club.clubId, memberId, planId, { startOffsetDays: -40, days: 60 });
    const month = (
      await client.query<{ m: string }>(
        `SELECT to_char(date_trunc('month', (now() AT TIME ZONE 'Europe/Sofia')::date - 31), 'YYYY-MM-DD') AS m`,
      )
    ).rows[0]?.m as string;
    const first = await recordClubMonthlyActivity(getDb(), month);
    expect(first).toBeGreaterThanOrEqual(1);
    const row = await client.query(
      `SELECT members_with_membership, members_active FROM club_monthly_activity
        WHERE club_id = $1 AND month = $2::date`,
      [club.clubId, month],
    );
    expect(row.rows[0]).toMatchObject({ members_with_membership: 1, members_active: 1 });
    expect(await recordClubMonthlyActivity(getDb(), month)).toBe(0);
  });
});

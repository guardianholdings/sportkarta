import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupClubFixtures,
  failure,
  makeClub,
  makeMember,
  makeOccurrence,
  makePlan,
  sellMembership,
  type ClubFixture,
} from './clubs/test-fixtures.js';

/**
 * Memberships, visits and status (0041, 0043) — all DERIVED.
 *
 *   * a visit card's remaining visits are the COUNT of check-ins that consumed
 *     it, plus the import offset — no counter exists to race on;
 *   * pauses extend the effective end date and cannot overlap (EXCLUDE);
 *   * one live trial per member;
 *   * attendance is recorded once per class and once per open-gym day, and an
 *     uncovered visit is RECORDED (covered = false), never refused;
 *   * a member's status (lead / trial / active / lapsed / archived) follows.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('club membership balances (requires running database)', () => {
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
    club = await makeClub(client, 'balances');
    memberId = await makeMember(client, club.clubId, 'Стоян');
  });

  async function balance(membershipId: string): Promise<Record<string, unknown>> {
    const row = await client.query(
      `SELECT state, visits_used, visits_remaining, paused_days,
              effective_ends_on - ends_on AS extension
         FROM club_membership_balances WHERE membership_id = $1`,
      [membershipId],
    );
    return row.rows[0] ?? {};
  }

  async function memberStatus(): Promise<string> {
    const row = await client.query<{ status: string }>(
      `SELECT status FROM club_member_status WHERE member_id = $1`,
      [memberId],
    );
    return row.rows[0]?.status ?? '';
  }

  async function checkIn(options: {
    membershipId?: string | null;
    occurrenceId?: string | null;
    dayOffset?: number;
    covered?: boolean;
  }): Promise<void> {
    await client.query(
      `INSERT INTO club_checkins (club_id, member_id, occurrence_id, location_id, method, recorded_by,
                                  consumed_membership_id, covered, sofia_day)
       VALUES ($1, $2, $3, $4, 'desk', $5, $6, $7,
               (now() AT TIME ZONE 'Europe/Sofia')::date - $8::int)`,
      [
        club.clubId,
        memberId,
        options.occurrenceId ?? null,
        club.locationId,
        club.ownerId,
        options.membershipId ?? null,
        options.covered ?? true,
        options.dayOffset ?? 0,
      ],
    );
  }

  it('counts visits from check-ins and the import offset', async () => {
    const planId = await makePlan(client, club.clubId, { kind: 'visits', visits: 5 });
    const { membershipId } = await sellMembership(client, club.clubId, memberId, planId, {
      offset: 2,
    });
    expect(await balance(membershipId)).toMatchObject({
      state: 'active',
      visits_used: 2,
      visits_remaining: 3,
    });
    for (const day of [0, 1, 2]) await checkIn({ membershipId, dayOffset: day });
    expect(await balance(membershipId)).toMatchObject({
      state: 'exhausted',
      visits_used: 5,
      visits_remaining: 0,
    });
    // An exhausted card does not make the member "active".
    expect(await memberStatus()).toBe('lapsed');
  });

  it('records attendance once per class and once per open-gym day — and never refuses', async () => {
    const { occurrenceId } = await makeOccurrence(client, club);
    await checkIn({ occurrenceId, covered: false });
    const twice = await failure(checkIn({ occurrenceId }));
    expect(twice.code).toBe('23505');

    await checkIn({});
    const sameDay = await failure(checkIn({}));
    expect(sameDay.code).toBe('23505');
    await checkIn({ dayOffset: 1 });

    const uncovered = await client.query(
      `SELECT count(*)::int AS n FROM club_checkins WHERE member_id = $1 AND NOT covered`,
      [memberId],
    );
    expect(uncovered.rows[0]?.n).toBe(1);
  });

  it('extends validity by pauses and refuses overlapping ones', async () => {
    const planId = await makePlan(client, club.clubId);
    const { membershipId } = await sellMembership(client, club.clubId, memberId, planId);
    await client.query(
      `INSERT INTO club_membership_pauses (club_id, membership_id, starts_on, ends_on)
       VALUES ($1, $2, current_date + 10, current_date + 16)`,
      [club.clubId, membershipId],
    );
    expect(await balance(membershipId)).toMatchObject({ paused_days: 7, extension: 7 });
    const overlap = await failure(
      client.query(
        `INSERT INTO club_membership_pauses (club_id, membership_id, starts_on, ends_on)
         VALUES ($1, $2, current_date + 16, current_date + 20)`,
        [club.clubId, membershipId],
      ),
    );
    expect(overlap.constraint).toBe('club_membership_pauses_no_overlap');

    await client.query(
      `INSERT INTO club_membership_pauses (club_id, membership_id, starts_on, ends_on)
       VALUES ($1, $2, (now() AT TIME ZONE 'Europe/Sofia')::date, (now() AT TIME ZONE 'Europe/Sofia')::date + 2)`,
      [club.clubId, membershipId],
    );
    expect(await balance(membershipId)).toMatchObject({ state: 'paused' });
    // Paused is still a live membership for the member's status.
    expect(await memberStatus()).toBe('active');
  });

  it('allows one live trial per member and derives lead → trial → active → lapsed', async () => {
    expect(await memberStatus()).toBe('lead');
    const trialPlan = await makePlan(client, club.clubId, {
      kind: 'trial',
      visits: 1,
      priceCents: 0,
    });
    await sellMembership(client, club.clubId, memberId, trialPlan, { days: 7 });
    expect(await memberStatus()).toBe('trial');
    const second = await failure(sellMembership(client, club.clubId, memberId, trialPlan));
    expect(second.constraint).toBe('club_memberships_one_trial');

    const monthly = await makePlan(client, club.clubId);
    const { membershipId } = await sellMembership(client, club.clubId, memberId, monthly);
    expect(await memberStatus()).toBe('active');

    await client.query(
      `UPDATE club_memberships SET cancelled_at = now(), cancel_reason = 'member_request'
        WHERE member_id = $1`,
      [memberId],
    );
    expect(await balance(membershipId)).toMatchObject({ state: 'cancelled' });
    expect(await memberStatus()).toBe('lapsed');

    await client.query(`UPDATE club_members SET archived_at = now() WHERE id = $1`, [memberId]);
    expect(await memberStatus()).toBe('archived');
  });

  it('treats a sale cancelled as a mistake as if it never happened', async () => {
    const monthly = await makePlan(client, club.clubId);
    await sellMembership(client, club.clubId, memberId, monthly);
    await client.query(
      `UPDATE club_memberships SET cancelled_at = now(), cancel_reason = 'mistake' WHERE member_id = $1`,
      [memberId],
    );
    expect(await memberStatus()).toBe('lead');
  });

  it('marks an expired membership and an upcoming one', async () => {
    const monthly = await makePlan(client, club.clubId);
    const past = await sellMembership(client, club.clubId, memberId, monthly, {
      startOffsetDays: -60,
      days: 30,
    });
    expect(await balance(past.membershipId)).toMatchObject({ state: 'expired' });
    expect(await memberStatus()).toBe('lapsed');
    const next = await sellMembership(client, club.clubId, memberId, monthly, {
      startOffsetDays: 3,
    });
    expect(await balance(next.membershipId)).toMatchObject({ state: 'upcoming' });
    expect(await memberStatus()).toBe('active');
  });
});

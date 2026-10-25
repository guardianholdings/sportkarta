import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { sofiaToday } from '@sportkarta/lib/clubs';

import { getDb } from './client.js';
import { clubMonthFigures } from './clubs/mail.js';
import { chargeClubBookingFees, renewClubMemberships } from './clubs/policies.js';
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
 * The club.policies job (0045): renewals and no-show / late-cancel fees.
 *
 * What must hold:
 *   - a renewing period that ended is followed by exactly one successor and
 *     one charge, however often the job runs (club_memberships_one_successor);
 *   - a member's notice, an archived plan or a suspended club stops renewing;
 *   - a successor must be the SAME client's period (the 3-column FK);
 *   - a no-show or a late cancel raises exactly one fee, a trial never, and a
 *     waived (voided) fee is never raised again;
 *   - a fee's booking_id may only be cleared (club_charges_guard), and erasing
 *     the client keeps the fee with member_id and booking_id cleared.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const LABELS = { noShow: 'Неявяване', lateCancel: 'Късно отказване' };

describe.skipIf(!hasDb)('club policies (requires running database)', () => {
  let client: pg.Client;
  let club: ClubFixture;
  let memberId: string;
  let planId: string;
  const today = sofiaToday();

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
    // Community tier: always writable (a paid tier needs paid_until or a trial).
    club = await makeClub(client, 'policies', { tier: 'community' });
    memberId = await makeMember(client, club.clubId, 'Мария');
    planId = await makePlan(client, club.clubId, { priceCents: 4500 });
    await client.query(`UPDATE club_plans SET auto_renew = true WHERE id = $1`, [planId]);
  });

  /** A renewing period that ended yesterday. */
  async function endedRenewing(): Promise<string> {
    const { membershipId } = await sellMembership(client, club.clubId, memberId, planId, {
      startOffsetDays: -30,
      days: 30,
    });
    await client.query(
      `UPDATE club_memberships SET renews = true, term_started_on = starts_on WHERE id = $1`,
      [membershipId],
    );
    return membershipId;
  }

  async function successors(membershipId: string) {
    const result = await client.query<{ id: string; starts_on: string; price_cents: number }>(
      `SELECT id, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, price_cents
         FROM club_memberships WHERE renewal_of = $1`,
      [membershipId],
    );
    return result.rows;
  }

  it('renews an ended period once, from the next day, with a charge', async () => {
    const first = await endedRenewing();
    const report = await renewClubMemberships(getDb(), today);
    expect(report.renewed).toBeGreaterThanOrEqual(1);
    const next = await successors(first);
    expect(next).toHaveLength(1);
    expect(next[0]?.starts_on).toBe(today);
    expect(next[0]?.price_cents).toBe(4500);
    const charge = await client.query(
      `SELECT kind, amount_cents FROM club_charges WHERE membership_id = $1`,
      [next[0]?.id],
    );
    expect(charge.rows).toEqual([{ kind: 'membership', amount_cents: 4500 }]);
    const audit = await client.query(
      `SELECT actor_kind FROM club_audit WHERE club_id = $1 AND action = 'membership_renewed'`,
      [club.clubId],
    );
    expect(audit.rows).toEqual([{ actor_kind: 'system' }]);

    // Idempotent: a second run (or a second worker) adds nothing.
    await renewClubMemberships(getDb(), today);
    expect(await successors(first)).toHaveLength(1);
  });

  it('charges the price the plan has NOW for the next period', async () => {
    const first = await endedRenewing();
    await client.query(`UPDATE club_plans SET price_cents = 5200 WHERE id = $1`, [planId]);
    await renewClubMemberships(getDb(), today);
    expect((await successors(first))[0]?.price_cents).toBe(5200);
  });

  it('stops at the end of the notice, and on an archived plan', async () => {
    const first = await endedRenewing();
    await client.query(
      `UPDATE club_memberships SET renewal_ends_on = (now() AT TIME ZONE 'Europe/Sofia')::date - 1
        WHERE id = $1`,
      [first],
    );
    const report = await renewClubMemberships(getDb(), today);
    expect(report.ended).toBeGreaterThanOrEqual(1);
    expect(await successors(first)).toHaveLength(0);
    const after = await client.query(`SELECT renews FROM club_memberships WHERE id = $1`, [first]);
    expect(after.rows[0]?.renews).toBe(false);

    const other = await makeMember(client, club.clubId, 'Иван');
    const { membershipId } = await sellMembership(client, club.clubId, other, planId, {
      startOffsetDays: -30,
      days: 30,
    });
    await client.query(`UPDATE club_memberships SET renews = true WHERE id = $1`, [membershipId]);
    await client.query(`UPDATE club_plans SET archived_at = now() WHERE id = $1`, [planId]);
    await renewClubMemberships(getDb(), today);
    expect(await successors(membershipId)).toHaveLength(0);
  });

  it('does not renew for a suspended club', async () => {
    const first = await endedRenewing();
    await client.query(
      `UPDATE clubs SET status = 'suspended', suspended_at = now() WHERE id = $1`,
      [club.clubId],
    );
    await renewClubMemberships(getDb(), today);
    expect(await successors(first)).toHaveLength(0);
  });

  it("refuses a successor that points at another client's period", async () => {
    const first = await endedRenewing();
    const other = await makeMember(client, club.clubId, 'Друг');
    const result = await failure(
      client.query(
        `INSERT INTO club_memberships (club_id, member_id, plan_id, plan_name, kind, audience,
                                       price_cents, starts_on, ends_on, renewal_of)
         SELECT club_id, $2, plan_id, plan_name, kind, audience, price_cents, ends_on + 1,
                ends_on + 30, id
           FROM club_memberships WHERE id = $1`,
        [first, other],
      ),
    );
    expect(result.code).toBe('23503');
    expect(result.constraint).toBe('club_memberships_renewal_fk');
  });

  it("sums a month for the owner's health mail", async () => {
    await sellMembership(client, club.clubId, memberId, planId, { startOffsetDays: 0, days: 30 });
    const first = `${today.slice(0, 7)}-01`;
    const figures = (await clubMonthFigures(getDb(), first)).find((f) => f.clubId === club.clubId);
    expect(figures?.members[0]).toBe(1);
    expect(figures?.newMembers).toBe(1);
    expect(figures?.churned).toBe(0);
  });

  describe('fees', () => {
    async function pastBookedOccurrence(options: { trial?: boolean } = {}) {
      const { classId, occurrenceId } = await makeOccurrence(client, club, { daysAhead: 2 });
      await client.query(
        `UPDATE club_classes SET no_show_fee_cents = 1000, late_cancel_fee_cents = 500 WHERE id = $1`,
        [classId],
      );
      const booking = await client.query<{ id: string }>(
        `INSERT INTO club_bookings (club_id, occurrence_id, member_id, booked_by, is_trial)
         VALUES ($1, $2, $3, 'desk', $4) RETURNING id`,
        [club.clubId, occurrenceId, memberId, options.trial ?? false],
      );
      // Move the class three days into the past, keeping the local clock true.
      await client.query(
        `UPDATE club_class_occurrences
            SET starts_at = starts_at - interval '5 days', ends_at = ends_at - interval '5 days',
                starts_at_local = (starts_at - interval '5 days') AT TIME ZONE 'Europe/Sofia'
          WHERE id = $1`,
        [occurrenceId],
      );
      return { occurrenceId, bookingId: booking.rows[0]?.id ?? '' };
    }

    async function feesFor(bookingId: string) {
      const result = await client.query<{ id: string; amount_cents: number; label: string }>(
        `SELECT id, amount_cents, label FROM club_charges WHERE booking_id = $1`,
        [bookingId],
      );
      return result.rows;
    }

    it('charges a no-show once, however often the job runs', async () => {
      const { bookingId } = await pastBookedOccurrence();
      await chargeClubBookingFees(getDb(), new Date(), () => LABELS);
      const fees = await feesFor(bookingId);
      expect(fees).toHaveLength(1);
      expect(fees[0]?.amount_cents).toBe(1000);
      expect(fees[0]?.label).toBe('Неявяване — Йога');

      await chargeClubBookingFees(getDb(), new Date(), () => LABELS);
      expect(await feesFor(bookingId)).toHaveLength(1);
    });

    it('does not charge a member who checked in, nor a trial', async () => {
      const { occurrenceId, bookingId } = await pastBookedOccurrence();
      await client.query(
        `INSERT INTO club_checkins (club_id, member_id, occurrence_id, location_id, method, recorded_by, covered, sofia_day)
         VALUES ($1, $2, $3, $4, 'desk', 'desk', true, (now() AT TIME ZONE 'Europe/Sofia')::date)`,
        [club.clubId, memberId, occurrenceId, club.locationId],
      );
      await chargeClubBookingFees(getDb(), new Date(), () => LABELS);
      expect(await feesFor(bookingId)).toHaveLength(0);

      const trialMember = await makeMember(client, club.clubId, 'Проба');
      memberId = trialMember;
      const trial = await pastBookedOccurrence({ trial: true });
      await chargeClubBookingFees(getDb(), new Date(), () => LABELS);
      expect(await feesFor(trial.bookingId)).toHaveLength(0);
    });

    it('never raises a waived fee again', async () => {
      const { bookingId } = await pastBookedOccurrence();
      await chargeClubBookingFees(getDb(), new Date(), () => LABELS);
      const [fee] = await feesFor(bookingId);
      await client.query(`UPDATE club_charges SET voided_at = now() WHERE id = $1`, [fee?.id]);
      await chargeClubBookingFees(getDb(), new Date(), () => LABELS);
      expect(await feesFor(bookingId)).toHaveLength(1);
    });

    it('charges a late cancellation', async () => {
      const { classId, occurrenceId } = await makeOccurrence(client, club, { daysAhead: 2 });
      await client.query(`UPDATE club_classes SET late_cancel_fee_cents = 500 WHERE id = $1`, [
        classId,
      ]);
      const booking = await client.query<{ id: string }>(
        `INSERT INTO club_bookings (club_id, occurrence_id, member_id, booked_by)
         VALUES ($1, $2, $3, 'desk') RETURNING id`,
        [club.clubId, occurrenceId, memberId],
      );
      const bookingId = booking.rows[0]?.id ?? '';
      await client.query(
        `UPDATE club_bookings SET state = 'late_cancelled', cancelled_at = now() WHERE id = $1`,
        [bookingId],
      );
      await chargeClubBookingFees(getDb(), new Date(), () => LABELS);
      const fees = await feesFor(bookingId);
      expect(fees.map((f) => [f.amount_cents, f.label])).toEqual([[500, 'Късно отказване — Йога']]);
    });

    it('lets booking_id only be cleared, and keeps the fee through the client erasure', async () => {
      const { bookingId } = await pastBookedOccurrence();
      await chargeClubBookingFees(getDb(), new Date(), () => LABELS);
      const [fee] = await feesFor(bookingId);
      const other = await pastBookedOccurrence();
      const moved = await failure(
        client.query(`UPDATE club_charges SET booking_id = $2 WHERE id = $1`, [
          fee?.id,
          other.bookingId,
        ]),
      );
      expect(moved.message).toMatch(
        /only voiding and anonymisation|booking_id may only be cleared/,
      );

      await client.query(`DELETE FROM club_members WHERE id = $1`, [memberId]);
      const kept = await client.query(
        `SELECT member_id, booking_id, amount_cents FROM club_charges WHERE id = $1`,
        [fee?.id],
      );
      expect(kept.rows).toEqual([{ member_id: null, booking_id: null, amount_cents: 1000 }]);
    });
  });
});

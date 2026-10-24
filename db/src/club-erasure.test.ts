import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupClubFixtures,
  ensureUser,
  makeClub,
  makeMember,
  makeOccurrence,
  makePlan,
  sellMembership,
  type ClubFixture,
} from './clubs/test-fixtures.js';

/**
 * Two erasures, two controllers (0040's header).
 *
 *  1. A PERSON ERASES THEIR POPS ACCOUNT. POPS is the controller of the
 *     account; each club is the controller of its client record. So the
 *     cascade removes exactly the person's link and staff rows and nothing a
 *     club owns, and NOTHING in the club schema can abort `DELETE FROM users`
 *     — erasure must never be blockable.
 *
 *  2. A CLUB ERASES ITS CLIENT (the client exercising Art. 17 at their gym).
 *     One DELETE on club_members removes their bookings, check-ins,
 *     memberships and links; the books stay whole with member_id cleared; a
 *     child of an erased guardian keeps their record.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('club erasure (requires running database)', () => {
  let client: pg.Client;
  let club: ClubFixture;
  let personId: string;
  let memberId: string;
  let chargeId: string;
  let membershipId: string;
  let classId: string;
  let occurrenceId: string;

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
    club = await makeClub(client, 'erasure');
    // The person is both a TRAINER at the club and a linked CLIENT of it, with
    // everything a busy member accumulates: a sale, a payment, a booking, a
    // check-in, a pause, an invite they issued, an audit row naming them.
    personId = await ensureUser(client, 'erasure_person');
    await client.query(
      `INSERT INTO club_staff (club_id, user_id, role, granted_by) VALUES ($1, $2, 'trainer', $3)`,
      [club.clubId, personId, club.ownerId],
    );
    memberId = await makeMember(client, club.clubId, 'Гергана', {
      email: `${personId}@example.org`,
    });
    await client.query(
      `INSERT INTO club_member_links (member_id, club_id, user_id, status, method, passport_consent_at)
       VALUES ($1, $2, $3, 'active', 'invite', now())`,
      [memberId, club.clubId, personId],
    );
    const planId = await makePlan(client, club.clubId);
    ({ membershipId, chargeId } = await sellMembership(client, club.clubId, memberId, planId));
    await client.query(
      `INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method, received_on, recorded_by)
       VALUES ($1, $2, $3, 'payment', 5000, 'card_desk', current_date, $4)`,
      [club.clubId, chargeId, memberId, club.ownerId],
    );
    ({ classId, occurrenceId } = await makeOccurrence(client, club, { instructorId: personId }));
    await client.query(
      `INSERT INTO club_bookings (club_id, occurrence_id, member_id, booked_by) VALUES ($1, $2, $3, $4)`,
      [club.clubId, occurrenceId, memberId, club.ownerId],
    );
    await client.query(
      `INSERT INTO club_checkins (club_id, member_id, location_id, method, recorded_by,
                                  consumed_membership_id, covered, sofia_day)
       VALUES ($1, $2, $3, 'desk', $4, $5, true, (now() AT TIME ZONE 'Europe/Sofia')::date)`,
      [club.clubId, memberId, club.locationId, club.ownerId, membershipId],
    );
    await client.query(
      `INSERT INTO club_membership_pauses (club_id, membership_id, starts_on, ends_on, created_by)
       VALUES ($1, $2, current_date + 10, current_date + 15, $3)`,
      [club.clubId, membershipId, club.ownerId],
    );
    await client.query(
      `INSERT INTO club_staff_invites (club_id, email, role, token_hash, expires_at, created_by)
       VALUES ($1, 'new-desk@example.org', 'desk', repeat('a', 64), now() + interval '7 days', $2)`,
      [club.clubId, personId],
    );
    await client.query(
      `INSERT INTO club_audit (club_id, actor_id, actor_kind, action, subject_member_id)
       VALUES ($1, $2, 'staff', 'checkin_recorded', $3)`,
      [club.clubId, personId, memberId],
    );
  });

  async function count(table: string, where = 'club_id = $1'): Promise<number> {
    const result = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, [
      club.clubId,
    ]);
    return Number(result.rows[0]?.n ?? 0);
  }

  it("erasing a POPS account takes only the person's link and grant", async () => {
    await client.query(`DELETE FROM users WHERE id = $1`, [personId]);

    expect(await count('club_member_links')).toBe(0);
    expect(await count('club_staff', `club_id = $1 AND role = 'trainer'`)).toBe(0);
    // Everything the club holds as controller stays.
    expect(await count('club_members')).toBe(1);
    expect(await count('club_memberships')).toBe(1);
    expect(await count('club_bookings')).toBe(1);
    expect(await count('club_checkins')).toBe(1);
    expect(await count('club_payments', 'club_id = $1 AND member_id IS NOT NULL')).toBe(1);
    expect(await count('club_audit')).toBe(1);
    // The class keeps running without a named instructor, and the invite the
    // trainer issued survives with its author cleared.
    const klass = await client.query(
      `SELECT status, instructor_user_id FROM club_classes WHERE id = $1`,
      [classId],
    );
    expect(klass.rows[0]).toEqual({ status: 'scheduled', instructor_user_id: null });
    expect(await count('club_staff_invites', 'club_id = $1 AND created_by IS NULL')).toBe(1);
  });

  it('erasing the OWNER account cannot be blocked either', async () => {
    await client.query(`DELETE FROM users WHERE id = $1`, [club.ownerId]);
    expect(await count('club_staff', `club_id = $1 AND role = 'owner'`)).toBe(0);
    expect(await count('club_members')).toBe(1);
  });

  it('a club erasing its client keeps the books, anonymised', async () => {
    const child = await makeMember(client, club.clubId, 'Дете', {
      isMinor: true,
      guardianId: memberId,
    });
    await client.query(`DELETE FROM club_members WHERE club_id = $1 AND id = $2`, [
      club.clubId,
      memberId,
    ]);

    expect(await count('club_member_links')).toBe(0);
    expect(await count('club_bookings')).toBe(0);
    expect(await count('club_checkins')).toBe(0);
    expect(await count('club_memberships')).toBe(0);
    expect(await count('club_membership_pauses')).toBe(0);
    // The money is still there and names nobody.
    expect(
      await count('club_charges', 'club_id = $1 AND member_id IS NULL AND membership_id IS NULL'),
    ).toBe(1);
    expect(await count('club_payments', 'club_id = $1 AND member_id IS NULL')).toBe(1);
    const balance = await client.query(
      `SELECT status, paid_cents FROM club_charge_balances WHERE charge_id = $1`,
      [chargeId],
    );
    expect(balance.rows[0]).toMatchObject({ status: 'paid', paid_cents: 5000 });
    // The child keeps their record; the guardian reference is cleared.
    const kid = await client.query(
      `SELECT guardian_member_id, is_minor FROM club_members WHERE id = $1`,
      [child],
    );
    expect(kid.rows[0]).toEqual({ guardian_member_id: null, is_minor: true });
    // The POPS account is untouched: the club erased ITS record.
    const account = await client.query(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [
      personId,
    ]);
    expect(account.rows[0]?.n).toBe(1);
  });
});

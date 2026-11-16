import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from './client.js';
import { broadcastTargets } from './clubs/audience.js';
import {
  clubLifecycleCandidates,
  clubMonthFigures,
  expiryCandidates,
  memberRecipient,
} from './clubs/mail.js';
import { channelAllowed, memberChannels } from './clubs/messaging.js';
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
 * The club audit of 2026-11-14, the mail half (db/src/clubs/mail.ts,
 * messaging.ts, audience.ts) — what was wrong, held as tests:
 *
 *   * an abonnement the renewals job will renew is not «expiring», and a pass
 *     shorter than the warning's own week is not warned about (C2);
 *   * the trial-ending warnings have a catch-up window like every other
 *     milestone, and still go once each (C9);
 *   * a one-click opt-out silences a LINKED member too, by every e-mail path (C5);
 *   * nobody is «at risk» before three weeks of membership, and the owner's
 *     monthly figure counts the same people the segment reaches (C10).
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('club mail, audit 2026-11-14 (requires running database)', () => {
  let client: pg.Client;
  let club: ClubFixture;
  let today = '';

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
    // Paid ahead: the club may write, so the renewals job would run for it.
    club = await makeClub(client, 'auditmail', { paid: true });
    today = String(
      (
        await client.query<{ d: string }>(
          `SELECT to_char((now() AT TIME ZONE 'Europe/Sofia')::date, 'YYYY-MM-DD') AS d`,
        )
      ).rows[0]?.d,
    );
  });

  const expiring = async (): Promise<string[]> =>
    (await expiryCandidates(getDb(), 'membership_expiring', today)).map((c) => c.membershipId);

  describe('C2 — «expiring» is only said of an abonnement that will really end', () => {
    it('does not warn about a period the renewals job will renew', async () => {
      const memberId = await makeMember(client, club.clubId, 'Подновява се');
      const planId = await makePlan(client, club.clubId);
      // Ends in four days.
      const { membershipId } = await sellMembership(client, club.clubId, memberId, planId, {
        startOffsetDays: -25,
        days: 30,
      });
      expect(await expiring()).toContain(membershipId);
      await client.query(`UPDATE club_memberships SET renews = true WHERE id = $1`, [membershipId]);
      expect(await expiring()).not.toContain(membershipId);
      // A card subscription renews itself (invoice.paid appends the period).
      await client.query(
        `UPDATE club_memberships SET provider_subscription_ref = 'sub_audit_1' WHERE id = $1`,
        [membershipId],
      );
      expect(await expiring()).not.toContain(membershipId);
    });

    it('still warns when the chain was stopped: notice, an archived plan, a club that may not write', async () => {
      const memberId = await makeMember(client, club.clubId, 'Спряна верига');
      const planId = await makePlan(client, club.clubId);
      const { membershipId } = await sellMembership(client, club.clubId, memberId, planId, {
        startOffsetDays: -25,
        days: 30,
      });
      const set = (assignment: string) =>
        client.query(`UPDATE club_memberships SET ${assignment} WHERE id = $1`, [membershipId]);
      await set(`renews = true`);
      expect(await expiring()).not.toContain(membershipId);

      // The member's notice runs out with this period: the next one is not appended.
      await set(`renewal_ends_on = ends_on`);
      expect(await expiring()).toContain(membershipId);
      // …but a notice that ends later still lets the next period start.
      await set(`renewal_ends_on = ends_on + 1`);
      expect(await expiring()).not.toContain(membershipId);
      await set(`renewal_ends_on = NULL`);

      // The plan was archived: the job ends the chain instead of renewing it.
      await client.query(`UPDATE club_plans SET archived_at = now() WHERE id = $1`, [planId]);
      expect(await expiring()).toContain(membershipId);
      await client.query(`UPDATE club_plans SET archived_at = NULL WHERE id = $1`, [planId]);
      expect(await expiring()).not.toContain(membershipId);

      // A club past its grace neither renews nor charges (policies.ts `writable`).
      await client.query(
        `UPDATE clubs SET paid_until = current_date - 60, trial_ends_on = NULL WHERE id = $1`,
        [club.clubId],
      );
      expect(await expiring()).toContain(membershipId);
      // Never paid, no trial: coverage is NULL, and NULL is not «will renew».
      await client.query(`UPDATE clubs SET paid_until = NULL WHERE id = $1`, [club.clubId]);
      expect(await expiring()).toContain(membershipId);
    });

    it('does not warn about a pass shorter than eight days, sold today', async () => {
      const planId = await makePlan(client, club.clubId);
      const sell = async (name: string, days: number): Promise<string> => {
        const memberId = await makeMember(client, club.clubId, name);
        return (await sellMembership(client, club.clubId, memberId, planId, { days })).membershipId;
      };
      const dayPass = await sell('Еднодневна', 1);
      const week = await sell('Седмица', 7);
      const eight = await sell('Осем дни', 8);
      const listed = await expiring();
      expect(listed).not.toContain(dayPass);
      expect(listed).not.toContain(week);
      expect(listed).toContain(eight);
    });
  });

  describe('C9 — the trial-ending warnings catch up, and go once each', () => {
    it('lists the week warning for three days and the last-day warning while it is still true', async () => {
      const paying = await makeClub(client, 'audittrial', { tier: 'standard' });
      const dbToday = String(
        (await client.query<{ d: string }>(`SELECT current_date::text AS d`)).rows[0]?.d,
      );
      const trial = async (daysAhead: number) => {
        await client.query(
          `UPDATE clubs SET trial_ends_on = current_date + $2::int, paid_until = NULL WHERE id = $1`,
          [paying.clubId, daysAhead],
        );
        return (await clubLifecycleCandidates(getDb(), dbToday)).filter(
          (c) => c.clubId === paying.clubId && c.kind === 'club_trial_ending',
        );
      };
      const endsOn = async (daysAhead: number) =>
        String(
          (
            await client.query<{ d: string }>(`SELECT (current_date + $1::int)::text AS d`, [
              daysAhead,
            ])
          ).rows[0]?.d,
        );

      // A week ahead, and the two days after a run that was missed: ONE anchor,
      // so the ledger key is the same on each of the three days.
      for (const ahead of [7, 6, 5]) {
        const date = await endsOn(ahead);
        expect(await trial(ahead)).toEqual([
          { kind: 'club_trial_ending', clubId: paying.clubId, date, anchor: `${date}:7` },
        ]);
      }
      // Between the two warnings: nothing.
      for (const ahead of [8, 4, 3, 2]) expect(await trial(ahead)).toEqual([]);
      // Tomorrow — or, a day late, today: the trial's last day is still ahead or here.
      for (const ahead of [1, 0]) {
        const date = await endsOn(ahead);
        expect(await trial(ahead)).toEqual([
          { kind: 'club_trial_ending', clubId: paying.clubId, date, anchor: `${date}:1` },
        ]);
      }
      // Over: «изтича» would be false; the past-due mail takes it from here.
      expect(await trial(-1)).toEqual([]);
    });
  });

  describe('C5 — a one-click opt-out silences a linked member too', () => {
    it('mails no linked member whose record opted out, by notice or by broadcast', async () => {
      const memberId = await makeMember(client, club.clubId, 'Отписан', {
        email: 'optout-record@example.org',
      });
      const userId = await ensureUser(client, 'auditoptout');
      await client.query(
        `INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
         VALUES ($1, $2, $3, 'active', 'invite')`,
        [memberId, club.clubId, userId],
      );
      expect(await memberRecipient(getDb(), club.clubId, memberId)).toMatchObject({
        email: `${userId}@example.org`,
        linked: true,
      });
      const before = await memberChannels(getDb(), club.clubId, memberId);
      expect(before?.email).toBe(`${userId}@example.org`);

      // The link in an older mail (sent while the record was unlinked) still works.
      await client.query(`UPDATE club_members SET email_opt_out_at = now() WHERE id = $1`, [
        memberId,
      ]);
      expect(await memberRecipient(getDb(), club.clubId, memberId)).toBeNull();
      const after = await memberChannels(getDb(), club.clubId, memberId);
      expect(after?.email).toBeNull();
      expect(after && channelAllowed(after, 'email', 'service')).toBe(false);
      // Push is the member's other switch (notify_push), not this one.
      expect(after?.pushUserId).toBe(userId);
    });

    it('applies the guardian record’s opt-out to mail about the child', async () => {
      const guardian = await makeMember(client, club.clubId, 'Родител');
      const child = await makeMember(client, club.clubId, 'Дете', {
        isMinor: true,
        guardianId: guardian,
      });
      const userId = await ensureUser(client, 'auditguardian');
      await client.query(
        `INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
         VALUES ($1, $2, $3, 'active', 'invite')`,
        [guardian, club.clubId, userId],
      );
      expect(await memberRecipient(getDb(), club.clubId, child)).not.toBeNull();
      await client.query(`UPDATE club_members SET email_opt_out_at = now() WHERE id = $1`, [
        guardian,
      ]);
      expect(await memberRecipient(getDb(), club.clubId, child)).toBeNull();
      expect((await memberChannels(getDb(), club.clubId, child))?.email).toBeNull();
    });
  });

  describe('C10 — «at risk» needs three weeks of membership, in one definition', () => {
    it('leaves out who bought today, and the monthly figure counts the segment’s people', async () => {
      const planId = await makePlan(client, club.clubId);
      const member = async (name: string, startOffsetDays: number): Promise<string> => {
        const memberId = await makeMember(client, club.clubId, name);
        await sellMembership(client, club.clubId, memberId, planId, { startOffsetDays, days: 90 });
        return memberId;
      };
      const visit = (memberId: string, daysAgo: number) =>
        client.query(
          `INSERT INTO club_checkins (club_id, member_id, location_id, method, recorded_by, covered,
                                      sofia_day, checked_in_at)
           VALUES ($1, $2, $3, 'desk', $4, true,
                   (now() AT TIME ZONE 'Europe/Sofia')::date - $5::int,
                   now() - make_interval(days => $5::int))`,
          [club.clubId, memberId, club.locationId, club.ownerId, daysAgo],
        );

      const boughtToday = await member('Купи днес', 0);
      const twoWeeks = await member('От две седмици', -14);
      const silent = await member('Не идва', -30);
      const regular = await member('Идва', -30);
      await visit(regular, 3);
      const lapsedVisitor = await member('Идваше', -60);
      await visit(lapsedVisitor, 40);
      // Left the club with time still on the abonnement: nobody to win back.
      const archived = await member('Напуснал', -30);
      await client.query(`UPDATE club_members SET archived_at = now() WHERE id = $1`, [archived]);

      const atRisk = await broadcastTargets(getDb(), club.clubId, {
        kind: 'segment',
        segment: 'at_risk',
      });
      expect(atRisk).not.toContain(boughtToday);
      expect(atRisk).not.toContain(twoWeeks);
      expect(atRisk).not.toContain(regular);
      expect(atRisk).not.toContain(archived);
      expect([...atRisk].sort()).toEqual([silent, lapsedVisitor].sort());

      const month = `${today.slice(0, 7)}-01`;
      const figures = (await clubMonthFigures(getDb(), month)).find(
        (f) => f.clubId === club.clubId,
      );
      expect(figures?.atRisk).toBe(atRisk.length);
    });
  });
});

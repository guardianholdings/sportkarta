import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupClubFixtures,
  ensureUser,
  failure,
  makeClub,
  makeMember,
  makeOccurrence,
  makePlan,
  type ClubFixture,
} from './clubs/test-fixtures.js';

/**
 * The «Клубове» schema's structural rules (0038–0044), asserted against real
 * Postgres. Each test names the rule from 0039's header it proves:
 *
 *   TENANCY IS IN THE KEYS — a row of club A cannot reference a row of club B,
 *   whatever the application does. That is the composite foreign keys, so the
 *   assertion is the SQLSTATE (23503), not an application error.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('club schema (requires running database)', () => {
  let client: pg.Client;
  let a: ClubFixture;
  let b: ClubFixture;

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
    a = await makeClub(client, 'schema-a');
    b = await makeClub(client, 'schema-b');
  });

  describe('tenancy is in the keys', () => {
    it("refuses a booking of club A's member on club B's occurrence", async () => {
      const memberA = await makeMember(client, a.clubId, 'Иван');
      const { occurrenceId: occB } = await makeOccurrence(client, b);
      // Whichever club_id the writer claims, one of the two composite keys fails.
      for (const claimed of [a.clubId, b.clubId]) {
        const result = await failure(
          client.query(
            `INSERT INTO club_bookings (club_id, occurrence_id, member_id, booked_by)
             VALUES ($1, $2, $3, $4)`,
            [claimed, occB, memberA, a.ownerId],
          ),
        );
        expect(result.code).toBe('23503');
      }
    });

    it("refuses a sale of club B's plan to club A's member", async () => {
      const memberA = await makeMember(client, a.clubId, 'Мария');
      const planB = await makePlan(client, b.clubId);
      const result = await failure(
        client.query(
          `INSERT INTO club_memberships (club_id, member_id, plan_id, plan_name, kind, audience,
                                         price_cents, starts_on, ends_on)
           VALUES ($1, $2, $3, 'X', 'unlimited', 'all', 100, current_date, current_date + 30)`,
          [a.clubId, memberA, planB],
        ),
      );
      expect(result.code).toBe('23503');
    });

    it('requires the instructor to be staff of the same club', async () => {
      const trainer = await ensureUser(client, 'schema_trainer');
      await client.query(
        `INSERT INTO club_staff (club_id, user_id, role) VALUES ($1, $2, 'trainer')`,
        [b.clubId, trainer],
      );
      // Staff of B, not of A: refused for A's class, accepted for B's.
      const refused = await failure(makeOccurrence(client, a, { instructorId: trainer }));
      expect(refused.code).toBe('23503');
      await makeOccurrence(client, b, { instructorId: trainer });
    });

    it('refuses a guardian from another club, and an adult with a guardian', async () => {
      const guardianB = await makeMember(client, b.clubId, 'Родител Б');
      const crossClub = await failure(
        makeMember(client, a.clubId, 'Дете', { isMinor: true, guardianId: guardianB }),
      );
      expect(crossClub.code).toBe('23503');

      const guardianA = await makeMember(client, a.clubId, 'Родител А');
      const adult = await failure(
        makeMember(client, a.clubId, 'Възрастен', { guardianId: guardianA }),
      );
      expect(adult.constraint).toBe('club_members_guardian_only_for_minors');
      await makeMember(client, a.clubId, 'Дете', { isMinor: true, guardianId: guardianA });
    });
  });

  describe('closed vocabularies and shapes', () => {
    it('rejects an rrule outside the 0008 subset (the CHECKs are verbatim)', async () => {
      for (const rule of ['FREQ=MONTHLY', 'FREQ=WEEKLY;BYSETPOS=1', 'FREQ=WEEKLY;BYDAY=1MO']) {
        const result = await failure(
          client.query(
            `INSERT INTO club_classes (club_id, location_id, title, sport, starts_at_local,
                                       duration_minutes, rrule)
             VALUES ($1, $2, 'X', 'yoga', now()::timestamp, 60, $3)`,
            [a.clubId, a.locationId, rule],
          ),
        );
        expect(result.constraint, rule).toBe('club_classes_rrule_supported');
      }
      await client.query(
        `INSERT INTO club_classes (club_id, location_id, title, sport, starts_at_local,
                                   duration_minutes, rrule)
         VALUES ($1, $2, 'X', 'yoga', now()::timestamp, 60, 'FREQ=WEEKLY;BYDAY=TU,TH')`,
        [a.clubId, a.locationId],
      );
    });

    it('cannot store a card key — only its 64-hex hash', async () => {
      const result = await failure(
        client.query(
          `INSERT INTO club_members (club_id, display_name, card_token_hash) VALUES ($1, 'X', $2)`,
          [a.clubId, 'skbc_live_secret_value'],
        ),
      );
      expect(result.constraint).toBe('club_members_card_hash_shape');
    });

    it('keeps tags short, comma-free and unique', async () => {
      for (const tags of [
        ['a,b'],
        [' padded'],
        ['VIP', 'vip'],
        Array.from({ length: 21 }, (_, i) => `t${String(i)}`),
      ]) {
        const result = await failure(
          client.query(
            `INSERT INTO club_members (club_id, display_name, tags) VALUES ($1, 'X', $2)`,
            [a.clubId, tags],
          ),
        );
        expect(result.constraint, JSON.stringify(tags)).toBe('club_members_tags_valid');
      }
      await client.query(
        `INSERT INTO club_members (club_id, display_name, tags) VALUES ($1, 'X', $2)`,
        [a.clubId, ['Сутрешна група', 'VIP']],
      );
    });

    it('pairs status with its timestamps', async () => {
      const pendingApproved = await failure(
        client.query(
          `INSERT INTO clubs (slug, name_bg, status, approved_at) VALUES ('e2e-bad-1', 'X', 'pending', now())`,
        ),
      );
      expect(pendingApproved.constraint).toBe('clubs_pending_not_approved');
      const activeUnapproved = await failure(
        client.query(
          `INSERT INTO clubs (slug, name_bg, status) VALUES ('e2e-bad-2', 'X', 'active')`,
        ),
      );
      expect(activeUnapproved.constraint).toBe('clubs_live_was_approved');
      const suspendedNoStamp = await failure(
        client.query(
          `INSERT INTO clubs (slug, name_bg, status, approved_at) VALUES ('e2e-bad-3', 'X', 'suspended', now())`,
        ),
      );
      expect(suspendedNoStamp.constraint).toBe('clubs_suspended_pair');
    });

    it('pins money to whole euro cents and the plan to one validity', async () => {
      const both = await failure(
        client.query(
          `INSERT INTO club_plans (club_id, name_bg, kind, price_cents, validity_days, validity_months)
           VALUES ($1, 'X', 'unlimited', 100, 30, 1)`,
          [a.clubId],
        ),
      );
      expect(both.constraint).toBe('club_plans_one_validity');
      const visitsWithoutCount = await failure(
        client.query(
          `INSERT INTO club_plans (club_id, name_bg, kind, price_cents, validity_days)
           VALUES ($1, 'X', 'visits', 100, 30)`,
          [a.clubId],
        ),
      );
      expect(visitsWithoutCount.constraint).toBe('club_plans_visits_match_kind');
    });
  });

  describe('admin_actions after 0039', () => {
    it('logs club-level actions without a subject and staff actions with one', async () => {
      // admin_actions is append-only by design; these rows name only fixture
      // ids, which resolve to nothing once the fixtures are gone.
      const admin = await ensureUser(client, 'schema_admin');
      await client.query(
        `INSERT INTO admin_actions (actor_id, action, detail)
           VALUES ($1, 'club_created', jsonb_build_object('clubId', $2::text))`,
        [admin, a.clubId],
      );
      const missingSubject = await failure(
        client.query(
          `INSERT INTO admin_actions (actor_id, action, detail)
             VALUES ($1, 'club_staff_granted', '{}'::jsonb)`,
          [admin],
        ),
      );
      expect(missingSubject.constraint).toBe('admin_actions_subject_matches_action');
      await client.query(
        `INSERT INTO admin_actions (actor_id, action, subject_id, detail)
           VALUES ($1, 'club_staff_granted', $2, '{}'::jsonb)`,
        [admin, a.ownerId],
      );
      // The original two national switches are unchanged by the rewrite.
      const settingWithSubject = await failure(
        client.query(
          `INSERT INTO admin_actions (actor_id, action, subject_id, detail)
             VALUES ($1, 'setting_changed', $2, '{}'::jsonb)`,
          [admin, a.ownerId],
        ),
      );
      expect(settingWithSubject.constraint).toBe('admin_actions_subject_matches_action');
    });
  });

  describe('views are security_invoker', () => {
    it('declares every club view with security_invoker', async () => {
      const views = await client.query<{ relname: string; options: string[] | null }>(
        `SELECT c.relname, c.reloptions AS options
           FROM pg_class c
          WHERE c.relkind = 'v' AND c.relname LIKE 'club\\_%'`,
      );
      expect(views.rows.map((r) => r.relname).sort()).toEqual([
        'club_booking_positions',
        'club_charge_balances',
        'club_charge_holds',
        'club_lead_stages',
        'club_member_status',
        'club_membership_balances',
        'club_product_stock',
        'club_wallet_balances',
      ]);
      for (const view of views.rows) {
        expect(view.options ?? [], view.relname).toContain('security_invoker=true');
      }
    });
  });
});

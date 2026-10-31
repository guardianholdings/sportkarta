import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { dedupeKey } from '@sportkarta/lib/clubs';

import { getDb } from './client.js';
import { broadcastTargets } from './clubs/audience.js';
import { recordClubMonthlyActivity } from './clubs/mail.js';
import {
  automationCandidates,
  channelAllowed,
  finishBroadcast,
  memberChannels,
  membersChannels,
  notePushResult,
  startBroadcast,
} from './clubs/messaging.js';
import {
  cleanupClubFixtures,
  ensureUser,
  failure,
  makeClub,
  makeMember,
  makePlan,
  purgeClub,
  sellMembership,
  type ClubFixture,
} from './clubs/test-fixtures.js';

/**
 * A club's messages (0051) — what the database itself guarantees:
 *
 *   * the send ledger is unique per (club, channel, key): one message may go
 *     by every channel, never twice by one; an SMS row says how many parts;
 *   * a club never sends more SMS parts in a Sofia month than the operator
 *     allowed, however many sends run at once;
 *   * a push subscription's endpoint is a known push service over https;
 *   * a broadcast never markets by push, names only its own club's plan or
 *     class, is fixed once scheduled and kept once sent;
 *   * an automation's delay and text fit its trigger and channel;
 *   * and the read side the worker relies on: who a group is (a guardian
 *     once), who may be written to by which channel, and which events an
 *     automation answers today.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

const FCM = 'https://fcm.googleapis.com/fcm/send/e2e-device-1';
const P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';

describe.skipIf(!hasDb)('club messaging (requires running database)', () => {
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
    club = await makeClub(client, 'messaging');
    memberId = await makeMember(client, club.clubId, 'Мария', { email: 'maria@example.org' });
  });

  const claim = (key: string, channel: string, parts: number | null = null) =>
    client.query(
      `INSERT INTO club_notifications (club_id, member_id, kind, dedupe_key, channel, sms_parts)
       VALUES ($1, $2, 'broadcast', $3, $4, $5)
       ON CONFLICT (club_id, channel, dedupe_key) DO NOTHING RETURNING id`,
      [club.clubId, memberId, key, channel, parts],
    );

  const sofiaToday = async () =>
    (
      await client.query<{ d: string }>(
        `SELECT to_char((now() AT TIME ZONE 'Europe/Sofia')::date, 'YYYY-MM-DD') AS d`,
      )
    ).rows[0]?.d as string;

  describe('the send ledger', () => {
    it('claims a key once per channel', async () => {
      await client.query(`UPDATE clubs SET sms_monthly_cap = 10 WHERE id = $1`, [club.clubId]);
      expect((await claim('broadcast:b1:m1', 'email')).rowCount).toBe(1);
      expect((await claim('broadcast:b1:m1', 'push')).rowCount).toBe(1);
      expect((await claim('broadcast:b1:m1', 'sms', 2)).rowCount).toBe(1);
      expect((await claim('broadcast:b1:m1', 'email')).rowCount).toBe(0);
      expect((await claim('broadcast:b1:m1', 'sms', 2)).rowCount).toBe(0);
    });

    it('records parts on an SMS and only there', async () => {
      expect((await failure(claim('k:1', 'email', 1))).constraint).toBe(
        'club_notifications_sms_parts_sane',
      );
      expect((await failure(claim('k:2', 'sms', null))).constraint).toBe(
        'club_notifications_sms_parts_sane',
      );
      expect((await failure(claim('k:3', 'fax'))).constraint).toBe(
        'club_notifications_channel_known',
      );
    });

    it('holds the monthly SMS allowance, and a re-claim is not a refusal', async () => {
      expect((await failure(claim('k:a', 'sms', 1))).constraint).toBe('club_notifications_sms_cap');
      await client.query(`UPDATE clubs SET sms_monthly_cap = 3 WHERE id = $1`, [club.clubId]);
      expect((await claim('k:a', 'sms', 2)).rowCount).toBe(1);
      expect((await failure(claim('k:b', 'sms', 2))).constraint).toBe('club_notifications_sms_cap');
      expect((await claim('k:c', 'sms', 1)).rowCount).toBe(1);
      // Already sent under this key: DO NOTHING decides, not the cap.
      expect((await claim('k:a', 'sms', 2)).rowCount).toBe(0);
    });

    it('cannot overshoot the allowance with parallel sends', async () => {
      await client.query(`UPDATE clubs SET sms_monthly_cap = 5 WHERE id = $1`, [club.clubId]);
      const others = await Promise.all(
        [0, 1, 2, 3].map(async () => {
          const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
          await c.connect();
          return c;
        }),
      );
      try {
        const results = await Promise.allSettled(
          others.map((c, i) =>
            c.query(
              `INSERT INTO club_notifications (club_id, member_id, kind, dedupe_key, channel, sms_parts)
               VALUES ($1, $2, 'broadcast', $3, 'sms', 2)`,
              [club.clubId, memberId, `par:${String(i)}`],
            ),
          ),
        );
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
        const used = await client.query<{ n: number }>(
          `SELECT coalesce(sum(sms_parts), 0)::int AS n FROM club_notifications
            WHERE club_id = $1 AND channel = 'sms'`,
          [club.clubId],
        );
        expect(used.rows[0]?.n).toBe(4);
      } finally {
        await Promise.all(others.map((c) => c.end()));
      }
    });

    it('freezes a month’s SMS parts into the activity figures', async () => {
      // The figures cover clubs that existed that month.
      await client.query(
        `UPDATE clubs SET sms_monthly_cap = 50, applied_at = timestamptz '2026-01-01 12:00+02'
          WHERE id = $1`,
        [club.clubId],
      );
      await client.query(
        `INSERT INTO club_notifications (club_id, member_id, kind, dedupe_key, channel, sms_parts, sent_at)
         VALUES ($1, $2, 'broadcast', 'old:1', 'sms', 3, timestamptz '2026-06-15 12:00+03')`,
        [club.clubId, memberId],
      );
      await recordClubMonthlyActivity(getDb(), '2026-06-01');
      const row = await client.query<{ sms_parts: number }>(
        `SELECT sms_parts FROM club_monthly_activity WHERE club_id = $1 AND month = '2026-06-01'`,
        [club.clubId],
      );
      expect(row.rows[0]?.sms_parts).toBe(3);
    });

    it('keeps the month’s count when a client is erased, and the send itself fixed', async () => {
      await client.query(`UPDATE clubs SET sms_monthly_cap = 4 WHERE id = $1`, [club.clubId]);
      expect((await claim('k:erased', 'sms', 3)).rowCount).toBe(1);
      // The club erases the client: their ledger rows go (0044's CASCADE)…
      await client.query(`DELETE FROM club_members WHERE id = $1`, [memberId]);
      const usage = await client.query<{ parts: number }>(
        `SELECT parts FROM club_sms_usage WHERE club_id = $1`,
        [club.clubId],
      );
      // …but what the club sent this month does not shrink.
      expect(usage.rows[0]?.parts).toBe(3);
      memberId = await makeMember(client, club.clubId, 'Нина');
      expect((await failure(claim('k:after', 'sms', 2))).constraint).toBe(
        'club_notifications_sms_cap',
      );
      expect((await claim('k:fits', 'sms', 1)).rowCount).toBe(1);
      expect(
        (
          await failure(
            client.query(`UPDATE club_notifications SET sms_parts = 1 WHERE club_id = $1`, [
              club.clubId,
            ]),
          )
        ).constraint,
      ).toBe('club_notifications_fixed');
      expect(
        (
          await failure(
            client.query(`UPDATE club_sms_usage SET parts = 0 WHERE club_id = $1`, [club.clubId]),
          )
        ).constraint,
      ).toBe('club_sms_usage_kept');
    });
  });

  describe('push subscriptions', () => {
    const subscribe = (userId: string, endpoint: string, p256dh = P256DH) =>
      client.query<{ id: string }>(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [userId, endpoint, p256dh, AUTH],
      );

    it('admits only known push services over https', async () => {
      const userId = await ensureUser(client, 'push_a');
      expect((await subscribe(userId, FCM)).rowCount).toBe(1);
      for (const endpoint of [
        'http://fcm.googleapis.com/fcm/send/x',
        'https://127.0.0.1/x',
        'https://fcm.googleapis.com.evil.example/x',
        'https://internal.service/x',
      ]) {
        expect((await failure(subscribe(userId, endpoint))).constraint).toBe(
          'push_subscriptions_endpoint_known',
        );
      }
      expect((await failure(subscribe(userId, `${FCM}-2`, 'short'))).constraint).toBe(
        'push_subscriptions_p256dh_shape',
      );
    });

    it('removes a device after twenty failures in a row', async () => {
      const userId = await ensureUser(client, 'push_c');
      const id = (await subscribe(userId, FCM)).rows[0]?.id as string;
      await client.query(`UPDATE push_subscriptions SET failure_count = 18 WHERE id = $1`, [id]);
      await notePushResult(getDb(), id, 'failed');
      expect(
        (await client.query(`SELECT failure_count FROM push_subscriptions WHERE id = $1`, [id]))
          .rows[0],
      ).toEqual({ failure_count: 19 });
      await notePushResult(getDb(), id, 'failed');
      expect(
        (await client.query(`SELECT 1 FROM push_subscriptions WHERE id = $1`, [id])).rowCount,
      ).toBe(0);
    });

    it('leaves with the account, and drops a gone device', async () => {
      const userId = await ensureUser(client, 'push_b');
      const id = (await subscribe(userId, FCM)).rows[0]?.id as string;
      await notePushResult(getDb(), id, 'gone');
      expect(
        (await client.query(`SELECT 1 FROM push_subscriptions WHERE id = $1`, [id])).rowCount,
      ).toBe(0);
      await subscribe(userId, FCM);
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
      expect(
        (await client.query(`SELECT 1 FROM push_subscriptions WHERE user_id = $1`, [userId]))
          .rowCount,
      ).toBe(0);
    });
  });

  describe('broadcasts', () => {
    const draft = (fields: Record<string, unknown> = {}) => {
      const row = {
        purpose: 'service',
        channels: ['email'],
        audience_kind: 'all',
        audience_value: null,
        plan_id: null,
        sms_body: null,
        ...fields,
      };
      return client.query<{ id: string }>(
        `INSERT INTO club_broadcasts (club_id, purpose, channels, audience_kind, audience_value,
                                      plan_id, subject, body, sms_body, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'Тема', 'Текст', $7, $8) RETURNING id`,
        [
          club.clubId,
          row.purpose,
          row.channels,
          row.audience_kind,
          row.audience_value,
          row.plan_id,
          row.sms_body,
          club.ownerId,
        ],
      );
    };

    it('never markets by push, and an SMS needs its own text', async () => {
      expect(
        (await failure(draft({ purpose: 'marketing', channels: ['email', 'push'] }))).constraint,
      ).toBe('club_broadcasts_marketing_no_push');
      expect((await failure(draft({ channels: ['sms'] }))).constraint).toBe(
        'club_broadcasts_sms_body',
      );
      expect((await draft({ channels: ['sms'], sms_body: 'Затворено' })).rowCount).toBe(1);
    });

    it('names a group by the closed lists, and only its own club’s plan', async () => {
      expect(
        (await failure(draft({ audience_kind: 'segment', audience_value: 'vip' }))).constraint,
      ).toBe('club_broadcasts_audience_known');
      expect((await failure(draft({ audience_kind: 'plan' }))).constraint).toBe(
        'club_broadcasts_audience_target',
      );
      const other = await makeClub(client, 'messaging-other');
      const foreignPlan = await makePlan(client, other.clubId);
      expect((await failure(draft({ audience_kind: 'plan', plan_id: foreignPlan }))).code).toBe(
        '23503',
      );
    });

    it('fixes the text once scheduled and keeps what was sent', async () => {
      const id = (await draft()).rows[0]?.id as string;
      await client.query(
        `UPDATE club_broadcasts SET status = 'scheduled', scheduled_for = now() WHERE id = $1`,
        [id],
      );
      expect(
        (
          await failure(
            client.query(`UPDATE club_broadcasts SET body = 'друго' WHERE id = $1`, [id]),
          )
        ).constraint,
      ).toBe('club_broadcasts_frozen');
      expect(
        (await failure(client.query(`DELETE FROM club_broadcasts WHERE id = $1`, [id]))).constraint,
      ).toBe('club_broadcasts_kept');
      const started = await startBroadcast(getDb(), id);
      expect(started?.channels).toEqual(['email']);
      expect(await finishBroadcast(getDb(), id)).toBe(true);
      expect(
        (
          await failure(
            client.query(`UPDATE club_broadcasts SET status = 'draft' WHERE id = $1`, [id]),
          )
        ).constraint,
      ).toBe('club_broadcasts_transition');
      // The purge still takes everything.
      await purgeClub(client, club.clubId);
      expect(
        (await client.query(`SELECT 1 FROM club_broadcasts WHERE id = $1`, [id])).rowCount,
      ).toBe(0);
    });

    it('begins every message as a draft', async () => {
      const forged = client.query(
        `INSERT INTO club_broadcasts (club_id, purpose, channels, audience_kind, subject, body,
                                      status, scheduled_for, started_at, finished_at,
                                      sent_email, sent_sms, sent_push, created_by)
         VALUES ($1, 'service', ARRAY['email'], 'all', 'Т', 'Т', 'sent', now(), now(), now(),
                 999, 0, 0, $2)`,
        [club.clubId, club.ownerId],
      );
      expect((await failure(forged)).constraint).toBe('club_broadcasts_transition');
    });

    it('stops a message being sent, and keeps the cancellation as it was', async () => {
      const id = (await draft()).rows[0]?.id as string;
      await client.query(
        `UPDATE club_broadcasts SET status = 'scheduled', scheduled_for = now() WHERE id = $1`,
        [id],
      );
      expect(await startBroadcast(getDb(), id)).not.toBeNull();
      await client.query(
        `UPDATE club_broadcasts SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2
          WHERE id = $1`,
        [id, club.ownerId],
      );
      expect(
        (
          await failure(
            client.query(
              `UPDATE club_broadcasts SET cancelled_at = now() - interval '1 day' WHERE id = $1`,
              [id],
            ),
          )
        ).constraint,
      ).toBe('club_broadcasts_frozen');
      expect(await finishBroadcast(getDb(), id)).toBe(false);
    });

    it('lets a draft go entirely', async () => {
      const id = (await draft()).rows[0]?.id as string;
      expect((await client.query(`DELETE FROM club_broadcasts WHERE id = $1`, [id])).rowCount).toBe(
        1,
      );
    });

    it('counts what went out from the ledger when it finishes', async () => {
      const id = (await draft({ channels: ['email', 'push'] })).rows[0]?.id as string;
      await client.query(
        `UPDATE club_broadcasts SET status = 'scheduled', scheduled_for = now() - interval '1 minute'
          WHERE id = $1`,
        [id],
      );
      await startBroadcast(getDb(), id);
      await claim(`broadcast:${id}:${memberId}`, 'email');
      await claim(`broadcast:${id}:${memberId}`, 'push');
      await finishBroadcast(getDb(), id);
      const row = await client.query<{ sent_email: number; sent_push: number; sent_sms: number }>(
        `SELECT sent_email, sent_push, sent_sms FROM club_broadcasts WHERE id = $1`,
        [id],
      );
      expect(row.rows[0]).toEqual({ sent_email: 1, sent_push: 1, sent_sms: 0 });
    });
  });

  describe('automations', () => {
    const automation = (trigger: string, channel: string, delay: number, subject: string | null) =>
      client.query(
        `INSERT INTO club_automations (club_id, trigger, channel, delay_days, subject, body)
         VALUES ($1, $2, $3, $4, $5, 'Текст')`,
        [club.clubId, trigger, channel, delay, subject],
      );

    it('fits the delay and the text to the trigger and channel', async () => {
      expect((await failure(automation('win_back', 'email', 7, 'Тема'))).constraint).toBe(
        'club_automations_delay_sane',
      );
      expect((await failure(automation('welcome', 'sms', 0, 'Тема'))).constraint).toBe(
        'club_automations_text_sane',
      );
      expect((await failure(automation('welcome', 'email', 0, null))).constraint).toBe(
        'club_automations_text_sane',
      );
      await automation('welcome', 'email', 0, 'Тема');
      expect((await failure(automation('welcome', 'email', 1, 'Друга'))).constraint).toBe(
        'club_automations_one_per_trigger',
      );
    });

    it('answers the first visit, and the last one after the gap, inside the window', async () => {
      const visit = (offset: number) =>
        client.query(
          `INSERT INTO club_checkins (club_id, member_id, location_id, method, recorded_by, covered,
                                      sofia_day, checked_in_at)
           VALUES ($1, $2, $3, 'desk', $4, false,
                   (now() AT TIME ZONE 'Europe/Sofia')::date + $5::int,
                   now() + make_interval(days => $5::int))`,
          [club.clubId, memberId, club.locationId, club.ownerId, offset],
        );
      await visit(-30);
      await visit(-21);
      const today = await sofiaToday();
      const auto = (trigger: 'welcome' | 'win_back', delayDays: number) =>
        automationCandidates(
          getDb(),
          { clubId: club.clubId, trigger, channel: 'email', delayDays },
          today,
        );
      expect(await auto('welcome', 29)).toEqual([{ memberId, anchor: 'first' }]);
      // Answered by THIS automation's channel, the event is not offered again;
      // another channel's answer (the club's SMS welcome) does not count.
      // The library's own key: the SQL that skips answered events must agree.
      const key = dedupeKey({ kind: 'automation', trigger: 'welcome', memberId, anchor: 'first' });
      const answer = (channel: 'push' | 'email') =>
        client.query(
          `INSERT INTO club_notifications (club_id, member_id, kind, dedupe_key, channel)
           VALUES ($1, $2, 'automation', $3, $4)`,
          [club.clubId, memberId, key, channel],
        );
      await answer('push');
      expect(await auto('welcome', 29)).toEqual([{ memberId, anchor: 'first' }]);
      await answer('email');
      expect(await auto('welcome', 29)).toEqual([]);
      // An event older than the catch-up window is not answered.
      expect(await auto('welcome', 0)).toEqual([]);
      const back = await auto('win_back', 21);
      expect(back).toHaveLength(1);
      expect(back[0]?.anchor).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(await auto('win_back', 14)).toEqual([]);
    });

    it('follows up an ended abonnement only when nothing came after it', async () => {
      const planId = await makePlan(client, club.clubId);
      const today = await sofiaToday();
      // Started 34 days ago for 30 days: ended five days ago.
      const ended = await sellMembership(client, club.clubId, memberId, planId, {
        startOffsetDays: -34,
        days: 30,
      });
      const auto = {
        clubId: club.clubId,
        trigger: 'expired_follow_up' as const,
        channel: 'email' as const,
        delayDays: 5,
      };
      expect(await automationCandidates(getDb(), auto, today)).toEqual([
        { memberId, anchor: ended.membershipId },
      ]);
      await sellMembership(client, club.clubId, memberId, planId);
      expect(await automationCandidates(getDb(), auto, today)).toEqual([]);
    });
  });

  describe('who receives, by which channel', () => {
    it('reaches a guardian once for several children, and never an archived record', async () => {
      const parent = await makeMember(client, club.clubId, 'Родител', { email: 'p@example.org' });
      await makeMember(client, club.clubId, 'Дете 1', { isMinor: true, guardianId: parent });
      await makeMember(client, club.clubId, 'Дете 2', { isMinor: true, guardianId: parent });
      const gone = await makeMember(client, club.clubId, 'Напуснал');
      await client.query(`UPDATE club_members SET archived_at = now() WHERE id = $1`, [gone]);
      const targets = await broadcastTargets(getDb(), club.clubId, { kind: 'all' });
      expect([...targets].sort()).toEqual([memberId, parent].sort());
    });

    it('writes to an unlinked record only on the club’s word, and markets only with consent', async () => {
      await client.query(`UPDATE club_members SET phone = '0888 123 456' WHERE id = $1`, [
        memberId,
      ]);
      let who = await memberChannels(getDb(), club.clubId, memberId);
      expect(who?.email).toBeNull();
      await client.query(`UPDATE clubs SET mail_unlinked_members = true WHERE id = $1`, [
        club.clubId,
      ]);
      who = await memberChannels(getDb(), club.clubId, memberId);
      expect(who && channelAllowed(who, 'email', 'service')).toBe(true);
      expect(who && channelAllowed(who, 'email', 'marketing')).toBe(false);
      expect(who && channelAllowed(who, 'sms', 'service')).toBe(true);
      expect(who && channelAllowed(who, 'push', 'service')).toBe(false);
      await client.query(
        `UPDATE club_members SET marketing_email_at = now(), sms_opt_out_at = now() WHERE id = $1`,
        [memberId],
      );
      who = (await membersChannels(getDb(), club.clubId, [memberId]))[0] ?? null;
      expect(who && channelAllowed(who, 'email', 'marketing')).toBe(true);
      expect(who && channelAllowed(who, 'sms', 'service')).toBe(false);
    });

    it('never addresses a minor, even one with their own linked account', async () => {
      const parent = await makeMember(client, club.clubId, 'Родител');
      const child = await makeMember(client, club.clubId, 'Дете', {
        isMinor: true,
        guardianId: parent,
      });
      await client.query(`UPDATE club_members SET phone = '0888 555 666' WHERE id = $1`, [child]);
      const childUser = await ensureUser(client, 'push_minor');
      await client.query(
        `INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
         VALUES ($1, $2, $3, 'active', 'invite')`,
        [child, club.clubId, childUser],
      );
      await client.query(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)`,
        [childUser, `${FCM}-minor`, P256DH, AUTH],
      );
      const who = await memberChannels(getDb(), club.clubId, child);
      // The guardian's record receives — it has no phone and no account.
      expect(who?.targetMemberId).toBe(parent);
      expect(who?.pushUserId).toBeNull();
      expect(who?.phone).toBeNull();
    });

    it('pushes to a linked member’s devices unless they muted the club', async () => {
      const userId = await ensureUser(client, 'push_member');
      await client.query(
        `INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
         VALUES ($1, $2, $3, 'active', 'invite')`,
        [memberId, club.clubId, userId],
      );
      await client.query(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)`,
        [userId, FCM, P256DH, AUTH],
      );
      let who = await memberChannels(getDb(), club.clubId, memberId);
      expect(who?.pushUserId).toBe(userId);
      expect(who?.pushDevices).toBe(true);
      expect(who && channelAllowed(who, 'push', 'marketing')).toBe(false);
      await client.query(`UPDATE club_member_links SET notify_push = false WHERE member_id = $1`, [
        memberId,
      ]);
      who = await memberChannels(getDb(), club.clubId, memberId);
      expect(who?.pushUserId).toBeNull();
    });
  });
});

import { getDb, getPool, sql } from '@sportkarta/db';
import { MemoryMailer } from '@sportkarta/lib/email';
import { MemoryPushSender } from '@sportkarta/lib/push';
import { MemorySmsSender } from '@sportkarta/lib/sms';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  broadcastReach,
  cancelBroadcast,
  deleteBroadcastDraft,
  saveAutomation,
  saveBroadcastDraft,
  saveSmsNotify,
  scheduleBroadcast,
} from '@/lib/clubs/messages';
import type { ClubActor } from '@/lib/clubs/scope';
import { unsubscribe } from '@/lib/clubs/unsubscribe';

import { runClubAutomations, runClubBroadcasts } from '../../../worker/src/club-messages-job';

import { hasDb } from './db';

vi.mock('server-only', () => ({}));

/**
 * A club's messages (0051), end to end: the office writes and schedules a
 * message through the app's own functions, and the WORKER's own code sends it
 * — by e-mail, SMS and push, to in-memory transports — against real
 * Postgres. What must hold:
 *
 *   * the group is read at send time, a guardian receives once, and each
 *     channel goes only where the rules allow (an unlinked record on the
 *     club's word, SMS to a phone that did not opt out, push to a linked
 *     member's devices, offers only with consent and never by push);
 *   * a second run sends nothing (the ledger), and the message closes with
 *     its counts; a notification never carries a member's name;
 *   * every offer carries its way out, and taking it stops the next offer;
 *   * the club's day limit, the relay's bulk limit and the SMS allowance hold;
 *   * an automation answers its event once.
 *
 * COMMITS, like the club journey, under its own `e2e-jm-*` club and
 * `e2e_club_jm_*` accounts, removed through the real purge path.
 */

const PREFIX = 'e2e_club_jm_';
const FCM = 'https://fcm.googleapis.com/fcm/send/e2e-jm-device';
const P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';

async function cleanup(): Promise<void> {
  const db = getDb();
  const clubs = await db.execute(sql`SELECT id FROM clubs WHERE slug LIKE 'e2e-jm-%'`);
  for (const row of clubs.rows) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('pops.purging_club', ${String(row.id)}, true)`);
      await tx.execute(sql`DELETE FROM clubs WHERE id = ${String(row.id)}::uuid`);
    });
  }
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`);
}

describe.skipIf(!hasDb)('club messages journey (requires running database)', () => {
  let db: ReturnType<typeof getDb>;
  let clubId = '';
  let clubName = '';
  let owner: ClubActor;
  let anaUser = '';
  let vera = '';
  let locationId = '';
  const mailer = new MemoryMailer();
  const sms = new MemorySmsSender();
  const push = new MemoryPushSender();
  const options = {
    mailer,
    siteUrl: 'https://pops.test',
    channels: { sms: { sender: sms, on: true }, push: { sender: push, on: true } },
    bulkMailDailyLimit: 1000,
    // Any hour of the day, and the whole allowance: the journey runs whenever
    // CI does (the hours and the share have their own case below).
    sendingHours: { from: 0, until: 24 },
    broadcastShare: 1,
  };
  const saved = {
    sms: process.env.CLUB_SMS_ENABLED,
    push: process.env.CLUB_PUSH_ENABLED,
  };

  async function account(label: string): Promise<string> {
    const id = `${PREFIX}${label}_${Math.random().toString(36).slice(2, 8)}`;
    await db.execute(sql`
      INSERT INTO users (id, display_name, email, email_verified)
      VALUES (${id}, ${`Journey ${label}`}, ${`${id}@example.org`}, true)
    `);
    return id;
  }

  async function member(
    name: string,
    fields: { email?: string; phone?: string; minorOf?: string; consent?: boolean } = {},
  ): Promise<string> {
    const consent = fields.consent ? sql`now()` : sql`NULL`;
    const result = await db.execute(sql`
      INSERT INTO club_members (club_id, display_name, email, phone, is_minor, guardian_member_id,
                                marketing_email_at, marketing_sms_at)
      VALUES (${clubId}::uuid, ${name}, ${fields.email ?? null}, ${fields.phone ?? null},
              ${fields.minorOf !== undefined}, ${fields.minorOf ?? null}::uuid, ${consent}, ${consent})
      RETURNING id
    `);
    return String(result.rows[0]?.id);
  }

  const reset = () => {
    mailer.sent.length = 0;
    sms.sent.length = 0;
    push.sent.length = 0;
  };

  async function newBroadcast(
    input: Partial<Parameters<typeof saveBroadcastDraft>[3]> = {},
  ): Promise<string> {
    const result = await saveBroadcastDraft(db, owner, null, {
      purpose: 'service',
      channels: ['email'],
      audience: { kind: 'all' },
      subject: 'Тема',
      body: 'Текст',
      smsBody: null,
      ...input,
    });
    expect(result.ok).toBe(true);
    return result.ok ? result.broadcastId : '';
  }

  /** Scheduled for now without the office's day limit — for the limit tests. */
  async function due(id: string): Promise<void> {
    await db.execute(sql`
      UPDATE club_broadcasts SET status = 'scheduled', scheduled_for = now() WHERE id = ${id}::uuid
    `);
  }

  beforeAll(async () => {
    db = getDb();
    process.env.CLUB_SMS_ENABLED = 'true';
    process.env.CLUB_PUSH_ENABLED = 'true';
    await cleanup();
    const ownerId = await account('owner');
    clubName = `Сила ${Math.random().toString(36).slice(2, 6)}`;
    const club = await db.execute(sql`
      INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until,
                         mail_unlinked_members, sms_monthly_cap)
      VALUES (${`e2e-jm-${Math.random().toString(36).slice(2, 8)}`}, ${clubName}, 'standard',
              'active', now(), (now() + interval '1 year')::date, true, 50)
      RETURNING id
    `);
    clubId = String(club.rows[0]?.id);
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${ownerId}, 'owner')
    `);
    owner = { userId: ownerId, clubId, role: 'owner', ngoAdmin: false };
    const location = await db.execute(sql`
      INSERT INTO club_locations (club_id, name, address)
      VALUES (${clubId}::uuid, 'Зала', 'ул. Тестова 1') RETURNING id
    `);
    locationId = String(location.rows[0]?.id);

    // Ana: linked to her POPS account, with one phone that accepted notifications.
    const ana = await member('Ана');
    anaUser = await account('ana');
    await db.execute(sql`
      INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
      VALUES (${ana}::uuid, ${clubId}::uuid, ${anaUser}, 'active', 'invite')
    `);
    await db.execute(sql`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
      VALUES (${anaUser}, ${FCM}, ${P256DH}, ${AUTH})
    `);
    // Boyko: unlinked, agreed to offers by e-mail and SMS.
    await member('Бойко', { email: 'boyko@example.org', phone: '0888 111 222', consent: true });
    // Vera: unlinked, no consent, and the guardian of a child in the club.
    vera = await member('Вера', { email: 'vera@example.org', phone: '0888 333 444' });
    await member('Дете', { minorOf: vera });
  });

  afterAll(async () => {
    process.env.CLUB_SMS_ENABLED = saved.sms;
    process.env.CLUB_PUSH_ENABLED = saved.push;
    await cleanup();
    await getPool().end();
  });

  it('sends a service message by every channel, to whom each one may reach', async () => {
    const id = await newBroadcast({
      channels: ['email', 'sms', 'push'],
      subject: 'Затворено в понеделник',
      body: 'Здравейте, {name}! Залата е затворена в понеделник.',
      smsBody: 'Залата е затворена в понеделник.',
    });
    const reach = await broadcastReach(
      owner,
      { audience: { kind: 'all' }, purpose: 'service' },
      'standard',
    );
    // Ana, Boyko and Vera — the child through Vera, once.
    expect(reach).toEqual({ recipients: 3, email: 3, sms: 2, push: 1 });

    expect((await scheduleBroadcast(db, owner, id, new Date())).ok).toBe(true);
    reset();
    const out = await runClubBroadcasts(options);
    expect(out.finished).toBe(1);
    expect(mailer.sent.map((m) => m.to).sort()).toEqual(
      [`${anaUser}@example.org`, 'boyko@example.org', 'vera@example.org'].sort(),
    );
    const toBoyko = mailer.sent.find((m) => m.to === 'boyko@example.org');
    expect(toBoyko?.subject).toBe(`${clubName} · Затворено в понеделник`);
    expect(toBoyko?.text).toContain('Здравейте, Бойко!');
    // An unlinked record's mail always carries the way out of all club mail.
    expect(toBoyko?.headers?.['List-Unsubscribe']).toMatch(
      /\/api\/clubs\/otpisvane\/[0-9a-f]{32}>$/,
    );
    expect(sms.sent.map((m) => m.to).sort()).toEqual(['+359888111222', '+359888333444']);
    expect(sms.sent[0]?.text).toBe(`${clubName}: Залата е затворена в понеделник.`);
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.payload.title).toBe(clubName);
    expect(push.sent[0]?.payload.body).toBe('Затворено в понеделник');
    expect(push.sent[0]?.payload.url).toMatch(/^\/klub\/e2e-jm-[a-z0-9]+\/az$/);
    // Nothing on a lock screen names a member.
    expect(JSON.stringify(push.sent)).not.toMatch(/Ана|Бойко|Вера/);

    const row = await db.execute(sql`
      SELECT status, sent_email, sent_sms, sent_push FROM club_broadcasts WHERE id = ${id}::uuid
    `);
    expect(row.rows[0]).toEqual({ status: 'sent', sent_email: 3, sent_sms: 2, sent_push: 1 });

    reset();
    await runClubBroadcasts(options);
    expect(mailer.sent.length + sms.sent.length + push.sent.length).toBe(0);
  });

  it('sends an offer only with consent, never by push, and with its way out', async () => {
    const id = await newBroadcast({
      purpose: 'marketing',
      channels: ['email', 'sms'],
      subject: '−20% през ноември',
      body: 'Отстъпка за абонаментите.',
      smsBody: '−20% през ноември.',
    });
    expect((await scheduleBroadcast(db, owner, id, new Date())).ok).toBe(true);
    reset();
    await runClubBroadcasts(options);
    expect(mailer.sent.map((m) => m.to)).toEqual(['boyko@example.org']);
    expect(mailer.sent[0]?.headers?.['List-Unsubscribe']).toMatch(/\?vid=marketing>$/);
    expect(mailer.sent[0]?.text).toContain('?vid=marketing');
    expect(sms.sent).toHaveLength(1);
    const token = /\/s\/([0-9a-f]{32})$/.exec(sms.sent[0]?.text ?? '')?.[1] ?? '';
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(push.sent).toHaveLength(0);

    // Boyko takes the way out: the next offer does not reach him.
    expect(await unsubscribe(token, 'marketing')).toBe(true);
    const next = await newBroadcast({ purpose: 'marketing', subject: 'Пак отстъпка' });
    expect((await scheduleBroadcast(db, owner, next, new Date())).ok).toBe(true);
    reset();
    await runClubBroadcasts(options);
    expect(mailer.sent).toHaveLength(0);
  });

  it('keeps the club to its messages a day', async () => {
    // Three left the draft today already.
    const fourth = await newBroadcast({ subject: 'Четвърто' });
    expect(await scheduleBroadcast(db, owner, fourth, new Date())).toEqual({
      ok: false,
      error: 'broadcast_daily_limit',
    });
    const tomorrow = new Date(Date.now() + 26 * 3600_000);
    expect((await scheduleBroadcast(db, owner, fourth, tomorrow)).ok).toBe(true);
  });

  it('holds a message at the relay’s daily limit and resumes it after', async () => {
    const id = await newBroadcast({ subject: 'Нов график' });
    await due(id);
    const sentToday = await db.execute(sql`
      SELECT count(*)::int AS n FROM club_notifications
       WHERE kind IN ('broadcast', 'automation') AND channel = 'email'
         AND sent_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Sofia') AT TIME ZONE 'Europe/Sofia'
    `);
    reset();
    const held = await runClubBroadcasts({
      ...options,
      bulkMailDailyLimit: Number(sentToday.rows[0]?.n ?? 0),
    });
    expect(held.held).toBe(true);
    expect(mailer.sent).toHaveLength(0);
    const still = await db.execute(sql`SELECT status FROM club_broadcasts WHERE id = ${id}::uuid`);
    // Started (its SMS and push would not wait), its e-mail held; still cancellable.
    expect(still.rows[0]?.status).toBe('sending');
    const resumed = await runClubBroadcasts(options);
    expect(resumed.finished).toBe(1);
    expect(mailer.sent).toHaveLength(3);
  });

  it('stops SMS at the club’s monthly allowance, without failing the run', async () => {
    const used = await db.execute(sql`
      SELECT coalesce(sum(sms_parts), 0)::int AS n FROM club_notifications
       WHERE club_id = ${clubId}::uuid AND channel = 'sms'
    `);
    await db.execute(sql`
      UPDATE clubs SET sms_monthly_cap = ${Number(used.rows[0]?.n ?? 0) + 1}
       WHERE id = ${clubId}::uuid
    `);
    const id = await newBroadcast({ channels: ['sms'], subject: 'SMS', smsBody: 'Кратко.' });
    await due(id);
    reset();
    const out = await runClubBroadcasts(options);
    expect(sms.sent).toHaveLength(1);
    expect(out.report.failed).toBe(0);
    expect(out.finished).toBe(1);
  });

  it('welcomes a member once, after the first visit', async () => {
    await db.execute(sql`
      INSERT INTO club_checkins (club_id, member_id, location_id, method, recorded_by, covered,
                                 sofia_day)
      VALUES (${clubId}::uuid, ${vera}::uuid, ${locationId}::uuid, 'desk', ${owner.userId}, false,
              (now() AT TIME ZONE 'Europe/Sofia')::date)
    `);
    expect(
      await saveAutomation(db, owner, {
        trigger: 'welcome',
        channel: 'email',
        delayDays: 0,
        subject: 'Добре дошли',
        body: 'Радваме се, че дойдохте, {name}.',
        active: true,
      }),
    ).toBe(true);
    reset();
    const first = await runClubAutomations(options);
    expect(first.report.failed).toBe(0);
    expect(mailer.sent.map((m) => m.to)).toEqual(['vera@example.org']);
    expect(mailer.sent[0]?.text).toContain('Радваме се, че дойдохте, Вера.');
    reset();
    await runClubAutomations(options);
    expect(mailer.sent).toHaveLength(0);
  });

  it('shares the automations’ allowance between clubs instead of serving one first', async () => {
    async function busyClub(label: string, visits: number): Promise<void> {
      const ownerId = await account(`owner_${label}`);
      const club = await db.execute(sql`
        INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until,
                           mail_unlinked_members)
        VALUES (${`e2e-jm-${label}-${Math.random().toString(36).slice(2, 8)}`}, ${`Клуб ${label}`},
                'standard', 'active', now(), (now() + interval '1 year')::date, true)
        RETURNING id
      `);
      const id = String(club.rows[0]?.id);
      await db.execute(sql`
        INSERT INTO club_staff (club_id, user_id, role) VALUES (${id}::uuid, ${ownerId}, 'owner')
      `);
      const actor: ClubActor = { userId: ownerId, clubId: id, role: 'owner', ngoAdmin: false };
      const location = await db.execute(sql`
        INSERT INTO club_locations (club_id, name, address)
        VALUES (${id}::uuid, 'Зала', 'ул. Тестова 2') RETURNING id
      `);
      for (let i = 0; i < visits; i += 1) {
        const row = await db.execute(sql`
          INSERT INTO club_members (club_id, display_name, email)
          VALUES (${id}::uuid, ${`Член ${String(i)}`}, ${`m${String(i)}@${label}.example.org`})
          RETURNING id
        `);
        await db.execute(sql`
          INSERT INTO club_checkins (club_id, member_id, location_id, method, recorded_by, covered,
                                     sofia_day)
          VALUES (${id}::uuid, ${String(row.rows[0]?.id)}::uuid, ${String(location.rows[0]?.id)}::uuid,
                  'desk', ${ownerId}, false, (now() AT TIME ZONE 'Europe/Sofia')::date)
        `);
      }
      expect(
        await saveAutomation(db, actor, {
          trigger: 'welcome',
          channel: 'email',
          delayDays: 0,
          subject: 'Добре дошли',
          body: 'Радваме се, {name}.',
          active: true,
        }),
      ).toBe(true);
    }
    const roomFor = async (n: number) => {
      const sentToday = await db.execute(sql`
        SELECT count(*)::int AS n FROM club_notifications
         WHERE kind IN ('broadcast', 'automation') AND channel = 'email'
           AND sent_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Sofia')
                          AT TIME ZONE 'Europe/Sofia'
      `);
      return { ...options, bulkMailDailyLimit: Number(sentToday.rows[0]?.n ?? 0) + n };
    };
    const perClub = (labels: string[]) =>
      labels.map(
        (label) => mailer.sent.filter((m) => m.to.endsWith(`@${label}.example.org`)).length,
      );

    // Two clubs, six first visits each, and room for six e-mails today.
    await busyClub('a', 6);
    await busyClub('b', 6);
    reset();
    const first = await runClubAutomations(await roomFor(6));
    expect(first.held).toBe(true);
    expect(first.report.failed).toBe(0);
    // Half each, whichever club comes first.
    expect(perClub(['a', 'b'])).toEqual([3, 3]);
    // The held answers go on the next run, and nobody is welcomed twice.
    reset();
    await runClubAutomations(options);
    expect(perClub(['a', 'b'])).toEqual([3, 3]);

    // A club that needs less than its part leaves the rest to the other.
    await busyClub('c', 5);
    await busyClub('d', 1);
    reset();
    const second = await runClubAutomations(await roomFor(4));
    expect(perClub(['c', 'd'])).toEqual([3, 1]);
    expect(second.held).toBe(true);
    expect(second.report.sent).toBe(4);
  });

  it('refuses every other role, another club and a club without the feature', async () => {
    const draftId = await newBroadcast({ subject: 'Само за собственика' });
    const staff = async (role: 'desk' | 'trainer'): Promise<ClubActor> => {
      const userId = await account(role);
      await db.execute(sql`
        INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${userId}, ${role})
      `);
      return { userId, clubId, role, ngoAdmin: false };
    };
    const input = {
      purpose: 'service' as const,
      channels: ['email' as const],
      audience: { kind: 'all' as const },
      subject: 'Опит',
      body: 'Текст',
      smsBody: null,
    };
    for (const actor of [await staff('desk'), await staff('trainer')]) {
      expect(await saveBroadcastDraft(db, actor, null, input)).toEqual({
        ok: false,
        error: 'readOnly',
      });
      expect(await saveBroadcastDraft(db, actor, draftId, input)).toEqual({
        ok: false,
        error: 'not_found',
      });
      expect((await scheduleBroadcast(db, actor, draftId, new Date())).ok).toBe(false);
      expect(await deleteBroadcastDraft(db, actor, draftId)).toBe(false);
      expect(
        await saveAutomation(db, actor, {
          trigger: 'welcome',
          channel: 'email',
          delayDays: 0,
          subject: 'Т',
          body: 'Т',
          active: true,
        }),
      ).toBe(false);
      expect(await saveSmsNotify(db, actor, ['reminder_24h'])).toBe(false);
    }

    // Another club's owner, with this club's message id in hand.
    async function otherClub(tier: 'standard' | 'community'): Promise<ClubActor> {
      const ownerId = await account(`other_${tier}`);
      const club = await db.execute(sql`
        INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until)
        VALUES (${`e2e-jm-${tier}-${Math.random().toString(36).slice(2, 8)}`}, 'Друг клуб', ${tier},
                'active', now(), (now() + interval '1 year')::date)
        RETURNING id
      `);
      const id = String(club.rows[0]?.id);
      await db.execute(sql`
        INSERT INTO club_staff (club_id, user_id, role) VALUES (${id}::uuid, ${ownerId}, 'owner')
      `);
      return { userId: ownerId, clubId: id, role: 'owner', ngoAdmin: false };
    }
    const stranger = await otherClub('standard');
    expect((await scheduleBroadcast(db, stranger, draftId, new Date())).ok).toBe(false);
    expect(await cancelBroadcast(db, stranger, draftId)).toBe(false);
    expect(await deleteBroadcastDraft(db, stranger, draftId)).toBe(false);
    expect(await saveBroadcastDraft(db, stranger, draftId, input)).toEqual({
      ok: false,
      error: 'not_found',
    });
    const still = await db.execute(sql`
      SELECT status, subject FROM club_broadcasts WHERE id = ${draftId}::uuid
    `);
    expect(still.rows[0]).toEqual({ status: 'draft', subject: 'Само за собственика' });

    // The community tier has no messages, no automations and no SMS.
    const community = await otherClub('community');
    expect(await saveBroadcastDraft(db, community, null, input)).toEqual({
      ok: false,
      error: 'readOnly',
    });
    expect(
      await saveAutomation(db, community, {
        trigger: 'welcome',
        channel: 'email',
        delayDays: 0,
        subject: 'Т',
        body: 'Т',
        active: true,
      }),
    ).toBe(false);
    expect(await saveSmsNotify(db, community, ['reminder_24h'])).toBe(false);
    expect(await deleteBroadcastDraft(db, owner, draftId)).toBe(true);
  });

  it('sends a group bigger than the day’s limit across two days, never twice', async () => {
    const id = await newBroadcast({ subject: 'На части' });
    await due(id);
    const today = async () =>
      Number(
        (
          await db.execute(sql`
            SELECT count(*)::int AS n FROM club_notifications
             WHERE kind IN ('broadcast', 'automation') AND channel = 'email'
               AND sent_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Sofia')
                              AT TIME ZONE 'Europe/Sofia'
          `)
        ).rows[0]?.n ?? 0,
      );
    reset();
    const first = await runClubBroadcasts({ ...options, bulkMailDailyLimit: (await today()) + 2 });
    expect(first.held).toBe(true);
    expect(mailer.sent).toHaveLength(2);
    // The next run has room for exactly one more: it is the one not yet reached.
    reset();
    const second = await runClubBroadcasts({ ...options, bulkMailDailyLimit: (await today()) + 1 });
    expect(second.finished).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it('stops a message being sent once it is cancelled, and retires a stale one', async () => {
    const sending = await newBroadcast({ subject: 'Спряно' });
    await due(sending);
    await db.execute(sql`
      UPDATE club_broadcasts SET status = 'sending', started_at = now() WHERE id = ${sending}::uuid
    `);
    expect(await cancelBroadcast(db, owner, sending)).toBe(true);
    const stale = await newBroadcast({ subject: 'Остаряло' });
    await db.execute(sql`
      UPDATE club_broadcasts SET status = 'scheduled', scheduled_for = now() - interval '4 days'
       WHERE id = ${stale}::uuid
    `);
    reset();
    const out = await runClubBroadcasts(options);
    expect(out.stale).toBe(1);
    expect(mailer.sent).toHaveLength(0);
    const rows = await db.execute(sql`
      SELECT id, status FROM club_broadcasts WHERE id IN (${sending}::uuid, ${stale}::uuid)
    `);
    expect(rows.rows.map((row) => row.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('counts a refusing device without retrying it, and puts no name on the lock screen', async () => {
    const id = await newBroadcast({ channels: ['push'], subject: 'Здравейте, {name}! Ново.' });
    await due(id);
    reset();
    await runClubBroadcasts(options);
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.payload.body).toBe('Здравейте! Ново.');

    push.rejected.add(FCM);
    const next = await newBroadcast({ channels: ['push'], subject: 'Втори' });
    await due(next);
    reset();
    const out = await runClubBroadcasts(options);
    push.rejected.delete(FCM);
    expect(out.report.failed).toBe(0);
    expect(out.finished).toBe(1);
    const device = await db.execute(sql`
      SELECT failure_count FROM push_subscriptions WHERE endpoint = ${FCM}
    `);
    expect(device.rows[0]?.failure_count).toBe(1);
    const counted = await db.execute(sql`
      SELECT sent_push FROM club_broadcasts WHERE id = ${next}::uuid
    `);
    expect(counted.rows[0]?.sent_push).toBe(0);
  });

  it('sends nothing at night, and keeps the automations’ part of the allowance', async () => {
    const id = await newBroadcast({ subject: 'Нощно' });
    await due(id);
    reset();
    const night = new Date('2026-10-26T01:00:00Z'); // 03:00 in Sofia
    const out = await runClubBroadcasts({ ...options, sendingHours: undefined }, undefined, night);
    expect(out.broadcasts).toBe(0);
    expect(mailer.sent).toHaveLength(0);
    // In the day, broadcasts stop at their share of the allowance even while
    // the day still has room: what is left is the automations'.
    const sentToday = await db.execute(sql`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE kind = 'broadcast')::int AS broadcasts
        FROM club_notifications
       WHERE kind IN ('broadcast', 'automation') AND channel = 'email'
         AND sent_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Sofia') AT TIME ZONE 'Europe/Sofia'
    `);
    const limit = Number(sentToday.rows[0]?.total ?? 0) + 4;
    const held = await runClubBroadcasts({
      ...options,
      bulkMailDailyLimit: limit,
      // A share that today's broadcasts have already used up.
      broadcastShare: Number(sentToday.rows[0]?.broadcasts ?? 0) / limit,
    });
    expect(held.held).toBe(true);
    expect(mailer.sent).toHaveLength(0);
    await runClubBroadcasts(options);
    expect(mailer.sent.length).toBeGreaterThan(0);
  });

  it('stops within a few recipients when the office cancels a message mid-send', async () => {
    for (let i = 0; i < 30; i += 1) {
      await db.execute(sql`
        INSERT INTO club_members (club_id, display_name, email, tags)
        VALUES (${clubId}::uuid, ${`Член ${String(i)}`}, ${`member${String(i)}@example.org`},
                ARRAY['масов'])
      `);
    }
    const id = await newBroadcast({ subject: 'Масово', audience: { kind: 'tag', tag: 'масов' } });
    await due(id);
    let sends = 0;
    const cancelling = {
      async send(message: Parameters<MemoryMailer['send']>[0]) {
        sends += 1;
        await mailer.send(message);
        if (sends === 5) expect(await cancelBroadcast(db, owner, id)).toBe(true);
      },
    };
    reset();
    const out = await runClubBroadcasts({ ...options, mailer: cancelling });
    expect(out.finished).toBe(0);
    // Stopped at the next check, far short of the thirty.
    expect(mailer.sent.length).toBeLessThan(15);
    const row = await db.execute(sql`
      SELECT status, sent_email FROM club_broadcasts WHERE id = ${id}::uuid
    `);
    expect(row.rows[0]?.status).toBe('cancelled');
    // What it reached before the cancel is kept on the message.
    expect(Number(row.rows[0]?.sent_email)).toBeGreaterThan(0);
  });
});

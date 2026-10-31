import { getDb, getPool, sql } from '@sportkarta/db';
import {
  INQUIRIES_PER_ACCOUNT_PER_DAY,
  INQUIRIES_PER_DAY,
  MEMBER_MESSAGES_PER_DAY,
  NEW_THREADS_PER_DAY,
} from '@sportkarta/lib/clubs';
import { MemoryMailer } from '@sportkarta/lib/email';
import { MemoryPushSender } from '@sportkarta/lib/push';
import { MemorySmsSender } from '@sportkarta/lib/sms';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bookTrial } from '@/lib/clubs/bookings';
import {
  feedbackOverview,
  giveFeedback,
  publicRating,
  saveGoogleReviewUrl,
} from '@/lib/clubs/feedback';
import {
  listThreads,
  memberThread,
  memberThreads,
  replyAsClub,
  sendInquiry,
  setThreadClosed,
  startThreadAsClub,
  threadForStaff,
  writeAsMember,
} from '@/lib/clubs/inbox';
import { changeLead, leadBoard, memberLead } from '@/lib/clubs/leads';
import { saveAutomation } from '@/lib/clubs/messages';
import type { ClubActor } from '@/lib/clubs/scope';

import { runClubLeadsDue, runClubNotify } from '../../../worker/src/club-mail-job';
import { runClubAutomations } from '../../../worker/src/club-messages-job';

import { hasDb } from './db';

vi.mock('server-only', () => ({}));

/**
 * The inbox, the prospects pipeline and ratings (0052), end to end: the
 * app's own functions write, and the WORKER's own code sends the notices, to
 * in-memory transports, against real Postgres. What must hold:
 *
 *   * a stranger's inquiry gets them a record of their own, a thread, and a
 *     prospect on the desk's board; the staff are told — without the text;
 *   * the club's answer reaches the member (e-mail and push, never the text),
 *     marks the prospect contacted, and a burst of messages is one notice;
 *   * only the front of house answers, only for its own club; the office
 *     writes first only to a member with an account; a thread is its own
 *     member's; a minor's record has no conversation; an NGO admin reads
 *     without marking and never writes; a lapsed club reads and answers
 *     nothing; a person's day is capped;
 *   * a trial booking puts a prospect on the board; the desk's decisions are
 *     the desk's (a trainer's are refused), and an owner must work here;
 *   * a member rates a class they came to, once, inside the window; EVERY
 *     rating offers the club's Google link (no review gating); the public
 *     average needs five ratings of classes the members scanned into;
 *   * a request to rate goes by e-mail, with consent, to the rating page;
 *   * the desk's daily list counts who to call — no names.
 *
 * COMMITS under its own `e2e-ji-*` club and `e2e_club_ji_*` accounts,
 * removed through the real purge path.
 */

const PREFIX = 'e2e_club_ji_';

async function cleanup(): Promise<void> {
  const db = getDb();
  const clubs = await db.execute(sql`SELECT id FROM clubs WHERE slug LIKE 'e2e-ji-%'`);
  for (const row of clubs.rows) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('pops.purging_club', ${String(row.id)}, true)`);
      await tx.execute(sql`DELETE FROM clubs WHERE id = ${String(row.id)}::uuid`);
    });
  }
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`);
}

describe.skipIf(!hasDb)(
  'club inbox, prospects and ratings journey (requires running database)',
  () => {
    let db: ReturnType<typeof getDb>;
    let clubId = '';
    let slug = '';
    let owner: ClubActor;
    let desk: ClubActor;
    let trainer: ClubActor;
    let locationId = '';
    const mailer = new MemoryMailer();
    const push = new MemoryPushSender();
    const options = {
      mailer,
      siteUrl: 'https://pops.test',
      channels: {
        sms: { sender: new MemorySmsSender(), on: false },
        push: { sender: push, on: true },
      },
      bulkMailDailyLimit: 1000,
      sendingHours: { from: 0, until: 24 },
      broadcastShare: 1,
    };
    const saved = { push: process.env.CLUB_PUSH_ENABLED };

    async function account(label: string): Promise<string> {
      const id = `${PREFIX}${label}_${Math.random().toString(36).slice(2, 8)}`;
      await db.execute(sql`
      INSERT INTO users (id, display_name, email, email_verified)
      VALUES (${id}, ${`Journey ${label}`}, ${`${id}@example.org`}, true)
    `);
      return id;
    }

    async function staff(role: 'desk' | 'trainer'): Promise<ClubActor> {
      const userId = await account(role);
      await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${userId}, ${role})
    `);
      return { userId, clubId, role, ngoAdmin: false };
    }

    /** A class of this club `days` from now (negative: in the past), with its occurrence. */
    async function occurrence(days: number, trial = false): Promise<string> {
      const klass = await db.execute(sql`
      INSERT INTO club_classes (club_id, location_id, title, sport, instructor_user_id,
                                starts_at_local, duration_minutes, capacity, public, trial_allowed,
                                booking_opens_hours)
      VALUES (${clubId}::uuid, ${locationId}::uuid, 'Йога', 'yoga', ${trainer.userId},
              (date_trunc('hour', now()) + make_interval(days => ${days}::int)) AT TIME ZONE 'Europe/Sofia',
              60, 10, true, ${trial}, 720)
      RETURNING id
    `);
      const result = await db.execute(sql`
      INSERT INTO club_class_occurrences (club_id, class_id, starts_at, ends_at, starts_at_local)
      SELECT c.club_id, c.id, c.starts_at_local AT TIME ZONE 'Europe/Sofia',
             (c.starts_at_local AT TIME ZONE 'Europe/Sofia') + interval '60 minutes', c.starts_at_local
        FROM club_classes c WHERE c.id = ${String(klass.rows[0]?.id)}::uuid
      RETURNING id
    `);
      return String(result.rows[0]?.id);
    }

    async function checkIn(
      memberId: string,
      occurrenceId: string,
      method: 'desk' | 'card' = 'desk',
    ): Promise<void> {
      await db.execute(sql`
      INSERT INTO club_checkins (club_id, member_id, occurrence_id, location_id, method, recorded_by,
                                 covered, sofia_day)
      VALUES (${clubId}::uuid, ${memberId}::uuid, ${occurrenceId}::uuid, ${locationId}::uuid, ${method},
              ${owner.userId}, false, (now() AT TIME ZONE 'Europe/Sofia')::date)
    `);
    }

    /** An account with its own record here, linked — a member who can open the portal. */
    async function member(
      label: string,
      minor = false,
    ): Promise<{ userId: string; memberId: string }> {
      const userId = await account(label);
      const record = await db.execute(sql`
      INSERT INTO club_members (club_id, display_name, email, is_minor)
      VALUES (${clubId}::uuid, ${`Член ${label}`}, ${`${userId}@example.org`}, ${minor})
      RETURNING id
    `);
      const memberId = String(record.rows[0]?.id);
      await db.execute(sql`
      INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
      VALUES (${memberId}::uuid, ${clubId}::uuid, ${userId}, 'active', 'self')
    `);
      return { userId, memberId };
    }

    const inquiry = {
      kind: 'rental' as const,
      on: null,
      partySize: null,
      body: 'Свободна ли е залата?',
    };

    const reset = () => {
      mailer.sent.length = 0;
      push.sent.length = 0;
    };

    beforeAll(async () => {
      db = getDb();
      process.env.CLUB_PUSH_ENABLED = 'true';
      await cleanup();
      const ownerId = await account('owner');
      slug = `e2e-ji-${Math.random().toString(36).slice(2, 8)}`;
      const club = await db.execute(sql`
      INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until)
      VALUES (${slug}, 'Клуб Входящи', 'standard', 'active', now(), (now() + interval '1 year')::date)
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
      desk = await staff('desk');
      trainer = await staff('trainer');
    });

    afterAll(async () => {
      process.env.CLUB_PUSH_ENABLED = saved.push;
      await cleanup();
      await getPool().end();
    });

    let visitor = '';
    let visitorRecord = '';
    let inquiryThread = '';
    let grownThread = '';

    it('turns a stranger’s inquiry into their record, a thread and a prospect — and tells the staff', async () => {
      visitor = await account('visitor');
      const sent = await sendInquiry(
        db,
        visitor,
        clubId,
        {
          kind: 'party',
          on: '2030-05-01',
          partySize: 12,
          body: 'Рожден ден за 12 деца, събота.',
        },
        'Рожден ден',
      );
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;
      inquiryThread = sent.threadId;
      const record = await db.execute(sql`
      SELECT m.id, m.source, m.lead_source FROM club_members m
        JOIN club_member_links l ON l.member_id = m.id AND l.user_id = ${visitor}
       WHERE m.club_id = ${clubId}::uuid
    `);
      visitorRecord = String(record.rows[0]?.id);
      expect(record.rows[0]).toMatchObject({ source: 'self', lead_source: 'inquiry' });
      expect((await memberLead(owner, visitorRecord, '2030-01-01'))?.stage).toBe('new');

      reset();
      await runClubNotify({ kind: 'inbox_message', messageId: sent.messageId }, options);
      // Everybody who answers the inbox — owner and desk, never the trainer.
      const to = mailer.sent.map((m) => m.to).sort();
      expect(to).toHaveLength(2);
      expect(to.some((address) => address.includes('_trainer_'))).toBe(false);
      for (const mail of mailer.sent) {
        expect(mail.text).not.toContain('12 деца');
        expect(mail.text).toContain(`/klub/${slug}/vhodyashti/${inquiryThread}`);
      }
    });

    it('lets only the club’s front of house read and answer — and the answer tells the member', async () => {
      expect(await threadForStaff(trainer, inquiryThread)).toBeNull();
      expect((await replyAsClub(db, trainer, inquiryThread, 'Опит')).ok).toBe(false);
      const stranger: ClubActor = {
        userId: await account('stranger'),
        clubId,
        role: null,
        ngoAdmin: false,
      };
      expect((await replyAsClub(db, stranger, inquiryThread, 'Опит')).ok).toBe(false);

      const read = await threadForStaff(desk, inquiryThread);
      expect(read?.messages).toHaveLength(1);
      expect((await listThreads(desk, 'unread')).map((t) => t.id)).not.toContain(inquiryThread);

      const reply = await replyAsClub(db, desk, inquiryThread, 'Здравейте! Свободни сме в събота.');
      expect(reply).toMatchObject({ ok: true, notify: true });
      if (!reply.ok) return;
      reset();
      await runClubNotify({ kind: 'inbox_message', messageId: reply.messageId }, options);
      expect(mailer.sent.map((m) => m.to)).toEqual([`${visitor}@example.org`]);
      expect(mailer.sent[0]?.text).not.toContain('Свободни сме');
      expect(mailer.sent[0]?.text).toContain(`/klub/${slug}/az/saobshteniya/${inquiryThread}`);
      // Answering the inquiry is calling the prospect.
      expect((await memberLead(owner, visitorRecord, '2030-01-01'))?.stage).toBe('contacted');

      // The member reads it without staff names; their two quick answers are one notice.
      const mine = await memberThread(visitor, clubId, inquiryThread);
      expect(mine?.messages.map((m) => m.staffName)).toEqual([null, null]);
      const first = await writeAsMember(
        db,
        visitor,
        clubId,
        { threadId: inquiryThread },
        'Чудесно!',
      );
      const second = await writeAsMember(
        db,
        visitor,
        clubId,
        { threadId: inquiryThread },
        'И още нещо.',
      );
      expect(first).toMatchObject({ ok: true, notify: true });
      expect(second).toMatchObject({ ok: true, notify: false });
    });

    it('writes first only to a member with an account', async () => {
      const unlinked = await db.execute(sql`
      INSERT INTO club_members (club_id, display_name, email)
      VALUES (${clubId}::uuid, 'Без профил', 'x@example.org')
      RETURNING id
    `);
      expect(
        await startThreadAsClub(db, owner, String(unlinked.rows[0]?.id), 'Тема', 'Текст'),
      ).toMatchObject({ ok: false, error: 'not_linked' });
      const started = await startThreadAsClub(
        db,
        owner,
        visitorRecord,
        'Нов график',
        'От понеделник',
      );
      expect(started.ok).toBe(true);
    });

    it('keeps a thread its own member’s, and gives a minor’s record no conversation', async () => {
      const other = await member('other');
      expect(await memberThread(other.userId, clubId, inquiryThread)).toBeNull();
      expect(
        await writeAsMember(db, other.userId, clubId, { threadId: inquiryThread }, 'Чужд'),
      ).toEqual({ ok: false, error: 'not_found' });

      const minor = await member('minor', true);
      expect(await startThreadAsClub(db, owner, minor.memberId, 'Тема', 'Текст')).toEqual({
        ok: false,
        error: 'minor_record',
      });
      expect(
        await writeAsMember(db, minor.userId, clubId, { subject: 'Здравейте' }, 'Текст'),
      ).toEqual({ ok: false, error: 'minor_record' });
      expect(await sendInquiry(db, minor.userId, clubId, inquiry, 'Наем')).toEqual({
        ok: false,
        error: 'minor_record',
      });
      // A record marked a minor's after its thread began: the club answers no more there.
      const grown = await member('grown');
      const started = await writeAsMember(db, grown.userId, clubId, { subject: 'Въпрос' }, 'Текст');
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      grownThread = started.threadId;
      await db.execute(sql`
      UPDATE club_members SET is_minor = true WHERE id = ${grown.memberId}::uuid
    `);
      expect(await replyAsClub(db, desk, grownThread, 'Отговор')).toEqual({
        ok: false,
        error: 'minor_record',
      });
    });

    it('sends an archived record, or one the club already keeps unclaimed, away from the inquiry', async () => {
      const archived = await member('archived');
      const asked = await writeAsMember(
        db,
        archived.userId,
        clubId,
        { subject: 'Пауза' },
        'Спирам за месец.',
      );
      expect(asked.ok).toBe(true);
      await db.execute(sql`
      UPDATE club_members SET archived_at = now() WHERE id = ${archived.memberId}::uuid
    `);
      expect(await sendInquiry(db, archived.userId, clubId, inquiry, 'Наем')).toEqual({
        ok: false,
        error: 'readOnly',
      });
      // It cannot answer back, so the club does not write into it either.
      if (asked.ok) {
        expect(await replyAsClub(db, desk, asked.threadId, 'Отговор')).toEqual({
          ok: false,
          error: 'readOnly',
        });
      }
      const claimer = await account('claimer');
      await db.execute(sql`
      INSERT INTO club_members (club_id, display_name, email)
      VALUES (${clubId}::uuid, 'Стар запис', ${`${claimer}@example.org`})
    `);
      expect(await sendInquiry(db, claimer, clubId, inquiry, 'Наем')).toEqual({
        ok: false,
        error: 'claim_first',
      });
    });

    it('caps a person’s day: new conversations, messages and inquiries', async () => {
      const busy = await member('busy');
      for (let i = 0; i < NEW_THREADS_PER_DAY; i += 1) {
        const opened = await writeAsMember(
          db,
          busy.userId,
          clubId,
          { subject: `Тема ${String(i)}` },
          'Текст',
        );
        expect(opened.ok).toBe(true);
      }
      expect(
        await writeAsMember(db, busy.userId, clubId, { subject: 'Още една' }, 'Текст'),
      ).toEqual({ ok: false, error: 'too_many_messages' });
      // Answers in a thread still go, up to the day's messages.
      const threadId = (await memberThreads(busy.userId, clubId))[0]?.id ?? '';
      await db.execute(sql`
      INSERT INTO club_thread_messages (club_id, thread_id, author, body)
      SELECT ${clubId}::uuid, ${threadId}::uuid, 'member', 'Пак'
        FROM generate_series(1, ${MEMBER_MESSAGES_PER_DAY - NEW_THREADS_PER_DAY - 1}::int)
    `);
      expect((await writeAsMember(db, busy.userId, clubId, { threadId }, 'Последно')).ok).toBe(
        true,
      );
      expect(await writeAsMember(db, busy.userId, clubId, { threadId }, 'Твърде много')).toEqual({
        ok: false,
        error: 'too_many_messages',
      });

      const asker = await account('asker');
      for (let i = 0; i < INQUIRIES_PER_DAY; i += 1) {
        expect((await sendInquiry(db, asker, clubId, inquiry, 'Наем')).ok).toBe(true);
      }
      expect(await sendInquiry(db, asker, clubId, inquiry, 'Наем')).toEqual({
        ok: false,
        error: 'too_many_messages',
      });

      // An account over its day across all clubs is refused at a club it never
      // wrote to — and leaves no record there.
      const roamer = await member('roamer');
      await db.execute(sql`
      INSERT INTO club_threads (club_id, member_id, kind, started_by, subject, inquiry_kind)
      SELECT ${clubId}::uuid, ${roamer.memberId}::uuid, 'inquiry', 'member', 'Наем', 'rental'
        FROM generate_series(1, ${INQUIRIES_PER_ACCOUNT_PER_DAY}::int)
    `);
      const elsewhere = await db.execute(sql`
      INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until)
      VALUES (${`e2e-ji-${Math.random().toString(36).slice(2, 8)}`}, 'Трети клуб', 'standard',
              'active', now(), (now() + interval '1 year')::date)
      RETURNING id
    `);
      const elsewhereId = String(elsewhere.rows[0]?.id);
      expect(await sendInquiry(db, roamer.userId, elsewhereId, inquiry, 'Наем')).toEqual({
        ok: false,
        error: 'too_many_messages',
      });
      const planted = await db.execute(sql`
      SELECT count(*)::int AS n FROM club_members WHERE club_id = ${elsewhereId}::uuid
    `);
      expect(planted.rows[0]?.n).toBe(0);
    });

    it('lets an NGO admin read without marking and never write; closing is the front of house’s', async () => {
      const adminId = await account('admin');
      await db.execute(sql`UPDATE users SET role = 'admin' WHERE id = ${adminId}`);
      const admin: ClubActor = { userId: adminId, clubId, role: null, ngoAdmin: true };
      expect(
        (await writeAsMember(db, visitor, clubId, { threadId: inquiryThread }, 'Има ли място?')).ok,
      ).toBe(true);
      const marker = async () =>
        (
          await db.execute(sql`
          SELECT club_read_at, club_read_at = last_member_at AS exact
            FROM club_threads WHERE id = ${inquiryThread}::uuid
        `)
        ).rows[0];
      const before = await marker();
      expect((await threadForStaff(admin, inquiryThread))?.unread).toBe(true);
      expect(await marker()).toEqual(before);
      expect(await replyAsClub(db, admin, inquiryThread, 'Опит')).toEqual({
        ok: false,
        error: 'readOnly',
      });
      expect(await startThreadAsClub(db, admin, visitorRecord, 'Тема', 'Текст')).toEqual({
        ok: false,
        error: 'readOnly',
      });
      expect(await setThreadClosed(db, admin, inquiryThread, true)).toBe(false);

      // The desk reads: the marker is the newest message it was shown, not the clock.
      await threadForStaff(desk, inquiryThread);
      expect((await marker())?.exact).toBe(true);

      expect(await setThreadClosed(db, trainer, inquiryThread, true)).toBe(false);
      expect(await setThreadClosed(db, desk, inquiryThread, true)).toBe(true);
      expect(await setThreadClosed(db, desk, inquiryThread, true)).toBe(false);
      expect((await listThreads(desk, 'closed')).map((t) => t.id)).toContain(inquiryThread);
      // The member writing re-opens it.
      expect(
        (await writeAsMember(db, visitor, clubId, { threadId: inquiryThread }, 'И още')).ok,
      ).toBe(true);
      expect((await listThreads(desk, 'open')).map((t) => t.id)).toContain(inquiryThread);
    });

    it('shows a long thread’s latest messages, oldest of them first', async () => {
      await db.execute(sql`
      INSERT INTO club_thread_messages (club_id, thread_id, author, body, created_at)
      SELECT ${clubId}::uuid, ${grownThread}::uuid, 'member', 'm' || g::text,
             now() + make_interval(secs => g / 1000.0)
        FROM generate_series(1, 501) g
    `);
      const read = await threadForStaff(desk, grownThread);
      expect(read?.messages).toHaveLength(500);
      expect(read?.messages[0]?.body).toBe('m2');
      expect(read?.messages.at(-1)?.body).toBe('m501');
    });

    it('keeps another club’s owner out, and a lapsed club reads but answers nothing', async () => {
      const otherOwnerId = await account('owner2');
      const other = await db.execute(sql`
      INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until)
      VALUES (${`e2e-ji-${Math.random().toString(36).slice(2, 8)}`}, 'Друг клуб', 'standard',
              'active', now(), (now() + interval '1 year')::date)
      RETURNING id
    `);
      const otherClubId = String(other.rows[0]?.id);
      await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role) VALUES (${otherClubId}::uuid, ${otherOwnerId}, 'owner')
    `);
      const otherOwner: ClubActor = {
        userId: otherOwnerId,
        clubId: otherClubId,
        role: 'owner',
        ngoAdmin: false,
      };
      expect(await threadForStaff(otherOwner, inquiryThread)).toBeNull();
      expect(await replyAsClub(db, otherOwner, inquiryThread, 'Опит')).toEqual({
        ok: false,
        error: 'not_found',
      });
      expect(await startThreadAsClub(db, otherOwner, visitorRecord, 'Тема', 'Текст')).toEqual({
        ok: false,
        error: 'not_found',
      });
      expect(await leadBoard(trainer, '2030-01-01')).toEqual([]);

      await db.execute(sql`
      UPDATE clubs SET paid_until = (now() - interval '1 year')::date WHERE id = ${clubId}::uuid
    `);
      try {
        expect(await threadForStaff(desk, inquiryThread)).not.toBeNull();
        expect(await replyAsClub(db, desk, inquiryThread, 'Опит')).toEqual({
          ok: false,
          error: 'readOnly',
        });
        expect(await startThreadAsClub(db, owner, visitorRecord, 'Тема', 'Текст')).toEqual({
          ok: false,
          error: 'readOnly',
        });
      } finally {
        await db.execute(sql`
        UPDATE clubs SET paid_until = (now() + interval '1 year')::date WHERE id = ${clubId}::uuid
      `);
      }
    });

    it('puts a trial booking on the board, and keeps the desk’s decisions the desk’s', async () => {
      const newcomer = await account('newcomer');
      const trial = await bookTrial(db, newcomer, clubId, await occurrence(2, true));
      expect(trial.ok).toBe(true);
      const board = await leadBoard(owner, '2030-01-01');
      expect(board.find((c) => c.source === 'trial')?.stage).toBe('trial_booked');

      // The next step with an owner who works here — not somebody else.
      expect(
        await changeLead(db, desk, visitorRecord, {
          kind: 'plan',
          nextActionOn: '2030-01-02',
          assignedTo: `${PREFIX}nobody`,
        }),
      ).toBe(false);
      expect(
        await changeLead(db, desk, visitorRecord, {
          kind: 'plan',
          nextActionOn: '2030-01-02',
          assignedTo: desk.userId,
        }),
      ).toBe(true);
      expect(await changeLead(db, trainer, visitorRecord, { kind: 'lost', reason: 'price' })).toBe(
        false,
      );
      expect(await changeLead(db, desk, visitorRecord, { kind: 'lost', reason: 'price' })).toBe(
        true,
      );
      expect((await memberLead(owner, visitorRecord, '2030-01-01'))?.stage).toBe('lost');
      expect(await changeLead(db, desk, visitorRecord, { kind: 'reopen' })).toBe(true);
      expect((await memberLead(owner, visitorRecord, '2030-01-01'))?.stage).toBe('contacted');
    });

    it('lets a member rate a class they came to, once, in the window — and offers the Google link after any rating', async () => {
      const past = await occurrence(-1);
      const subject = { kind: 'class' as const, occurrenceId: past };
      expect(
        await giveFeedback(db, visitor, clubId, { subject, rating: 5, comment: null }),
      ).toEqual({
        ok: false,
        error: 'not_attended',
      });
      await checkIn(visitorRecord, past);
      expect(await saveGoogleReviewUrl(db, owner, 'https://g.page/r/CbX1abc_-9/review')).toBe(true);
      expect(
        await giveFeedback(db, visitor, clubId, { subject, rating: 5, comment: 'Страхотно' }),
      ).toEqual({ ok: true, googleReviewUrl: 'https://g.page/r/CbX1abc_-9/review' });
      expect(
        await giveFeedback(db, visitor, clubId, { subject, rating: 3, comment: null }),
      ).toEqual({
        ok: false,
        error: 'already_rated',
      });
      // A bad rating is offered the same link: no review gating.
      const another = await occurrence(-1);
      await checkIn(visitorRecord, another);
      expect(
        await giveFeedback(db, visitor, clubId, {
          subject: { kind: 'class', occurrenceId: another },
          rating: 1,
          comment: 'Студено',
        }),
      ).toEqual({ ok: true, googleReviewUrl: 'https://g.page/r/CbX1abc_-9/review' });
      // Past the window: no more.
      const old = await occurrence(-20);
      await checkIn(visitorRecord, old);
      expect(
        await giveFeedback(db, visitor, clubId, {
          subject: { kind: 'class', occurrenceId: old },
          rating: 4,
          comment: null,
        }),
      ).toEqual({ ok: false, error: 'not_allowed' });
      // Two ratings are not shown publicly — five are needed.
      expect(await publicRating(clubId)).toBeNull();
      // The comments are management's to read.
      expect(await feedbackOverview(desk, 'bg')).toBeNull();
      expect(await feedbackOverview(trainer, 'bg')).toBeNull();
      expect((await feedbackOverview(owner, 'bg'))?.count).toBe(2);
    });

    it('shows a public average only from five ratings of classes the members scanned into', async () => {
      const past = await occurrence(-2);
      const rate = async (label: string): Promise<void> => {
        const record = await db.execute(sql`
        INSERT INTO club_members (club_id, display_name) VALUES (${clubId}::uuid, ${label})
        RETURNING id
      `);
        const id = String(record.rows[0]?.id);
        await checkIn(id, past, 'card');
        await db.execute(sql`
        INSERT INTO club_feedback (club_id, member_id, occurrence_id, rating)
        VALUES (${clubId}::uuid, ${id}::uuid, ${past}::uuid, 4)
      `);
      };
      for (const label of ['А', 'Б', 'В', 'Г']) await rate(label);
      // Six ratings in all, but the visitor's two came by a desk tick: four count.
      expect(await publicRating(clubId)).toBeNull();
      await rate('Д');
      expect(await publicRating(clubId)).toEqual({ average: 4, count: 5 });
    });

    it('asks for a rating by e-mail, only with consent, with a button to the rating page', async () => {
      const past = await occurrence(-1);
      await checkIn(visitorRecord, past);
      expect(
        await saveAutomation(db, owner, {
          trigger: 'feedback_request',
          channel: 'email',
          delayDays: 0,
          subject: 'Как беше?',
          body: 'Оценете тренировката, {name}.',
          active: true,
        }),
      ).toBe(true);
      // A marketing message: no consent, no e-mail.
      reset();
      await runClubAutomations(options);
      expect(mailer.sent.filter((m) => m.to === `${visitor}@example.org`)).toHaveLength(0);
      await db.execute(sql`
        UPDATE club_members SET marketing_email_at = now() WHERE id = ${visitorRecord}::uuid
      `);
      reset();
      await runClubAutomations(options);
      const mine = mailer.sent.filter((m) => m.to === `${visitor}@example.org`);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.text).toContain(`/klub/${slug}/az/otzivi`);
    });

    it('lists the desk’s prospects to call, counts only', async () => {
      // A prospect the desk owns that nobody has called for two days (the
      // visitor has visited by now, so is off the list).
      await db.execute(sql`
        INSERT INTO club_members (club_id, display_name, phone, lead_opened_at, lead_source,
                                  lead_assigned_to)
        VALUES (${clubId}::uuid, 'Обаждане', '0888 000 111', now() - interval '2 days', 'phone',
                ${desk.userId})
      `);
      reset();
      const report = await runClubLeadsDue(options);
      expect(report.failed).toBe(0);
      const forDesk = mailer.sent.find((m) => m.to === `${desk.userId}@example.org`);
      expect(forDesk?.text).toContain(`/klub/${slug}/chlenove/potentsialni`);
      expect(forDesk?.text).not.toContain('Обаждане');
      expect(forDesk?.text).not.toContain('0888');
    });
  },
);

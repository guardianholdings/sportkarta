import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from './client.js';
import { inboxNoticeOf, leadsDue } from './clubs/inbox.js';
import { automationCandidates } from './clubs/messaging.js';
import {
  cleanupClubFixtures,
  ensureUser,
  failure,
  makeClub,
  makeMember,
  makeOccurrence,
  makePlan,
  purgeClub,
  sellMembership,
  type ClubFixture,
} from './clubs/test-fixtures.js';

/**
 * A club's inbox, prospects and ratings (0052) — what the database itself
 * guarantees:
 *
 *   * a thread says what it is (an inquiry carries its kind, and only an
 *     inquiry a date and a party); the club's side of a message names who
 *     wrote it, a message is never edited, and the thread's read markers
 *     follow every message — forward only;
 *   * only somebody who came rates a class, once, and the trainer is the
 *     database's to record, not the form's; a rating is never edited;
 *   * a prospect's facts exist only in the pipeline, a lost one says why,
 *     and its stage is derived from the books — a trial, a visit, a sale;
 *   * the Google review link is one of Google's own review shapes;
 *   * erasing a record erases its conversations and ratings, and the purge
 *     empties all three tables.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('club inbox, prospects and ratings (requires running database)', () => {
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
    club = await makeClub(client, 'inbox');
    memberId = await makeMember(client, club.clubId, 'Мария', { email: 'maria@example.org' });
  });

  async function thread(
    fields: {
      kind?: string;
      startedBy?: string;
      inquiryKind?: string | null;
      on?: string | null;
      party?: number | null;
    } = {},
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO club_threads (club_id, member_id, kind, started_by, subject, inquiry_kind,
                                 inquiry_on, party_size)
       VALUES ($1, $2, $3, $4, 'Тема', $5, $6::date, $7) RETURNING id`,
      [
        club.clubId,
        memberId,
        fields.kind ?? 'message',
        fields.startedBy ?? 'member',
        fields.inquiryKind ?? null,
        fields.on ?? null,
        fields.party ?? null,
      ],
    );
    return result.rows[0]?.id ?? '';
  }

  async function write(threadId: string, author: 'member' | 'club', at?: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO club_thread_messages (club_id, thread_id, author, staff_user_id, body, created_at)
       VALUES ($1, $2, $3, $4, 'Здравейте', coalesce($5::timestamptz, now())) RETURNING id`,
      [club.clubId, threadId, author, author === 'club' ? club.ownerId : null, at ?? null],
    );
    return result.rows[0]?.id ?? '';
  }

  async function markers(threadId: string) {
    const result = await client.query(
      `SELECT last_member_at, last_club_at, member_read_at, club_read_at, closed_at
         FROM club_threads WHERE id = $1`,
      [threadId],
    );
    return result.rows[0] as Record<string, Date | null>;
  }

  async function checkIn(occurrenceId: string, who = memberId): Promise<void> {
    await client.query(
      `INSERT INTO club_checkins (club_id, member_id, occurrence_id, location_id, method,
                                  recorded_by, covered, sofia_day)
       VALUES ($1, $2, $3, $4, 'desk', $5, false, (now() AT TIME ZONE 'Europe/Sofia')::date)`,
      [club.clubId, who, occurrenceId, club.locationId, club.ownerId],
    );
  }

  describe('threads and messages', () => {
    it('lets an inquiry, and only an inquiry, carry its kind, a date and a party', async () => {
      await thread({ kind: 'inquiry', inquiryKind: 'party', on: '2030-01-10', party: 12 });
      expect((await failure(thread({ kind: 'inquiry' }))).constraint).toBe(
        'club_threads_inquiry_fields',
      );
      expect((await failure(thread({ kind: 'message', inquiryKind: 'camp' }))).constraint).toBe(
        'club_threads_inquiry_fields',
      );
      expect((await failure(thread({ kind: 'message', party: 3 }))).constraint).toBe(
        'club_threads_inquiry_fields',
      );
      expect(
        (await failure(thread({ kind: 'inquiry', inquiryKind: 'camp', startedBy: 'club' })))
          .constraint,
      ).toBe('club_threads_started_by_known');
      expect(
        (await failure(thread({ kind: 'inquiry', inquiryKind: 'camp', on: 'infinity' })))
          .constraint,
      ).toBe('club_threads_inquiry_on_finite');
    });

    it('names who wrote for the club, never edits a message, and moves markers forward only', async () => {
      const id = await thread();
      const first = await write(id, 'member');
      const after = await markers(id);
      expect(after.last_member_at).not.toBeNull();
      expect(after.member_read_at?.getTime()).toBe(after.last_member_at?.getTime());
      expect(after.club_read_at).toBeNull();

      expect(
        (
          await failure(
            client.query(
              `INSERT INTO club_thread_messages (club_id, thread_id, author, body)
               VALUES ($1, $2, 'club', 'Без автор')`,
              [club.clubId, id],
            ),
          )
        ).constraint,
      ).toBe('club_thread_messages_author_known');
      const edited = await failure(
        client.query(`UPDATE club_thread_messages SET body = 'друго' WHERE id = $1`, [first]),
      );
      expect(edited.code).toBe('23514');
      expect(edited.constraint).toBe('club_thread_messages_fixed');

      // A message whose transaction began earlier never moves a marker back.
      await write(id, 'member', '2000-01-01T00:00:00Z');
      const still = await markers(id);
      expect(still.last_member_at?.getTime()).toBe(after.last_member_at?.getTime());

      await write(id, 'club');
      const answered = await markers(id);
      expect(answered.last_club_at).not.toBeNull();
      expect(answered.club_read_at?.getTime()).toBe(answered.last_club_at?.getTime());
    });

    it('re-opens a closed thread when the member writes, not when the club does', async () => {
      const id = await thread();
      await client.query(
        `UPDATE club_threads SET closed_at = now(), closed_by = $2 WHERE id = $1`,
        [id, club.ownerId],
      );
      await write(id, 'club');
      expect((await markers(id)).closed_at).not.toBeNull();
      await write(id, 'member');
      expect((await markers(id)).closed_at).toBeNull();
    });

    it('tells the worker who wrote, and whether the other side already read it', async () => {
      const id = await thread({
        kind: 'inquiry',
        inquiryKind: 'rental',
        on: '2030-03-01',
        party: 4,
      });
      const message = await write(id, 'member');
      const notice = await inboxNoticeOf(getDb(), message);
      expect(notice).toMatchObject({
        author: 'member',
        threadKind: 'inquiry',
        inquiryKind: 'rental',
        inquiryOn: '2030-03-01',
        partySize: 4,
        memberName: 'Мария',
        alreadyRead: false,
      });
      await client.query(`UPDATE club_threads SET club_read_at = now() WHERE id = $1`, [id]);
      expect((await inboxNoticeOf(getDb(), message))?.alreadyRead).toBe(true);
    });
  });

  describe('ratings', () => {
    function rate(occurrenceId: string, rating = 5, instructor: string | null = null) {
      return client.query<{ id: string; instructor_user_id: string | null }>(
        `INSERT INTO club_feedback (club_id, member_id, occurrence_id, instructor_user_id, rating, comment)
         VALUES ($1, $2, $3, $4, $5, 'Чудесно') RETURNING id, instructor_user_id`,
        [club.clubId, memberId, occurrenceId, instructor, rating],
      );
    }

    it('admits only somebody who came, once, and records the trainer itself', async () => {
      const trainer = await ensureUser(client, 'inbox_trainer');
      await client.query(
        `INSERT INTO club_staff (club_id, user_id, role) VALUES ($1, $2, 'trainer')`,
        [club.clubId, trainer],
      );
      const { occurrenceId } = await makeOccurrence(client, club, {
        daysAhead: -1,
        instructorId: trainer,
      });
      const refused = await failure(rate(occurrenceId));
      expect(refused.code).toBe('23514');
      expect(refused.constraint).toBe('club_feedback_attended');

      await checkIn(occurrenceId);
      // Whatever the form sends, the class's trainer that day is recorded.
      const rated = await rate(occurrenceId, 5, club.ownerId);
      expect(rated.rows[0]?.instructor_user_id).toBe(trainer);
      expect((await failure(rate(occurrenceId, 4))).constraint).toBe(
        'club_feedback_occurrence_unique',
      );
      const edited = await failure(
        client.query(`UPDATE club_feedback SET rating = 1 WHERE id = $1`, [rated.rows[0]?.id]),
      );
      expect(edited.constraint).toBe('club_feedback_fixed');
    });

    it('asks a linked member who came to rate, until they rated or were asked lately', async () => {
      const { occurrenceId } = await makeOccurrence(client, club, { daysAhead: -1 });
      const ana = await makeMember(client, club.clubId, 'Ана');
      await checkIn(occurrenceId);
      await checkIn(occurrenceId, ana);
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(
        new Date(),
      ) as `${number}-${number}-${number}`;
      const candidates = async () =>
        (
          await automationCandidates(
            getDb(),
            { clubId: club.clubId, trigger: 'feedback_request', channel: 'email', delayDays: 0 },
            today,
          )
        ).map((c) => c.memberId);
      // No POPS account: no portal to rate in, so no request.
      expect(await candidates()).toEqual([]);
      for (const [record, label] of [
        [memberId, 'inbox_maria'],
        [ana, 'inbox_ana'],
      ] as const) {
        await client.query(
          `INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
           VALUES ($1, $2, $3, 'active', 'invite')`,
          [record, club.clubId, await ensureUser(client, label)],
        );
      }
      expect((await candidates()).sort()).toEqual([memberId, ana].sort());
      // Maria rated already: nothing to ask her.
      await client.query(
        `INSERT INTO club_feedback (club_id, member_id, occurrence_id, rating) VALUES ($1, $2, $3, 5)`,
        [club.clubId, memberId, occurrenceId],
      );
      // Ana was asked about another class within 30 days: not asked again.
      await client.query(
        `INSERT INTO club_notifications (club_id, member_id, kind, dedupe_key, channel)
         VALUES ($1, $2, 'automation', $3, 'email')`,
        [club.clubId, ana, `automation:feedback_request:${ana}:other`],
      );
      expect(await candidates()).toEqual([]);
    });

    it('keeps a rating between 1 and 5, with a comment of at most 500 characters', async () => {
      const { occurrenceId } = await makeOccurrence(client, club, { daysAhead: -1 });
      await checkIn(occurrenceId);
      expect((await failure(rate(occurrenceId, 6))).constraint).toBe('club_feedback_rating_sane');
      expect(
        (
          await failure(
            client.query(
              `INSERT INTO club_feedback (club_id, member_id, occurrence_id, rating, comment)
               VALUES ($1, $2, $3, 5, $4)`,
              [club.clubId, memberId, occurrenceId, 'а'.repeat(501)],
            ),
          )
        ).constraint,
      ).toBe('club_feedback_comment_sane');
    });
  });

  describe('the prospects pipeline', () => {
    async function stage(): Promise<string | undefined> {
      const result = await client.query<{ stage: string }>(
        `SELECT stage FROM club_lead_stages WHERE member_id = $1`,
        [memberId],
      );
      return result.rows[0]?.stage;
    }

    it('keeps the facts in the pipeline only, and a lost prospect says why', async () => {
      expect(
        (
          await failure(
            client.query(`UPDATE club_members SET lead_source = 'phone' WHERE id = $1`, [memberId]),
          )
        ).constraint,
      ).toBe('club_members_lead_fields_need_lead');
      await client.query(
        `UPDATE club_members SET lead_opened_at = now(), lead_source = 'phone' WHERE id = $1`,
        [memberId],
      );
      expect(
        (
          await failure(
            client.query(`UPDATE club_members SET lead_lost_at = now() WHERE id = $1`, [memberId]),
          )
        ).constraint,
      ).toBe('club_members_lead_lost_pair');
      expect(
        (
          await failure(
            client.query(
              `UPDATE club_members SET lead_next_action_on = '-infinity' WHERE id = $1`,
              [memberId],
            ),
          )
        ).constraint,
      ).toBe('club_members_lead_dates_finite');
      expect(
        (
          await failure(
            client.query(`UPDATE club_members SET lead_source = 'billboard' WHERE id = $1`, [
              memberId,
            ]),
          )
        ).constraint,
      ).toBe('club_members_lead_source_known');
    });

    it('moves a card by the books: called, trial, visit, sale — and a sale after a loss wins', async () => {
      expect(await stage()).toBeUndefined();
      await client.query(
        `UPDATE club_members SET lead_opened_at = now() - interval '1 minute', lead_source = 'inquiry'
          WHERE id = $1`,
        [memberId],
      );
      expect(await stage()).toBe('new');
      await client.query(`UPDATE club_members SET lead_contacted_at = now() WHERE id = $1`, [
        memberId,
      ]);
      expect(await stage()).toBe('contacted');
      const trial = await makePlan(client, club.clubId, { kind: 'trial' });
      await sellMembership(client, club.clubId, memberId, trial, { days: 7 });
      expect(await stage()).toBe('trial_booked');
      const { occurrenceId } = await makeOccurrence(client, club, { daysAhead: -1 });
      await checkIn(occurrenceId);
      expect(await stage()).toBe('visited');
      await client.query(
        `UPDATE club_members SET lead_lost_at = now() - interval '10 seconds',
                                 lead_lost_reason = 'price' WHERE id = $1`,
        [memberId],
      );
      expect(await stage()).toBe('lost');
      const plan = await makePlan(client, club.clubId);
      await sellMembership(client, club.clubId, memberId, plan);
      expect(await stage()).toBe('won');
    });

    it('lists due prospects for their owner, and unowned ones for everybody who works them — each once', async () => {
      // A club that may write (the daily list skips one that may not).
      await client.query(
        `UPDATE clubs SET paid_until = (now() + interval '1 year')::date WHERE id = $1`,
        [club.clubId],
      );
      const desk = await ensureUser(client, 'inbox_desk');
      await client.query(
        `INSERT INTO club_staff (club_id, user_id, role) VALUES ($1, $2, 'desk')`,
        [club.clubId, desk],
      );
      const other = await makeMember(client, club.clubId, 'Петър');
      // Maria: nobody called for two days AND a next step today, owned by the
      // desk — due for both reasons, counted once.
      await client.query(
        `UPDATE club_members SET lead_opened_at = now() - interval '2 days', lead_source = 'inquiry',
                                 lead_next_action_on = (now() AT TIME ZONE 'Europe/Sofia')::date,
                                 lead_assigned_to = $2 WHERE id = $1`,
        [memberId, desk],
      );
      // Petar: called, next step today, nobody owns it.
      await client.query(
        `UPDATE club_members SET lead_opened_at = now() - interval '3 days', lead_source = 'phone',
                                 lead_contacted_at = now() - interval '2 days',
                                 lead_next_action_on = (now() AT TIME ZONE 'Europe/Sofia')::date
          WHERE id = $1`,
        [other],
      );
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(
        new Date(),
      ) as `${number}-${number}-${number}`;
      const due = (await leadsDue(getDb(), ['owner', 'manager', 'desk'], today)).filter(
        (row) => row.clubId === club.clubId,
      );
      expect(due).toEqual(
        expect.arrayContaining([
          { clubId: club.clubId, userId: desk, uncalled: 1, planned: 2, due: 2 },
          { clubId: club.clubId, userId: club.ownerId, uncalled: 0, planned: 1, due: 1 },
        ]),
      );
      expect(due).toHaveLength(2);
    });
  });

  it('admits only Google’s own review link shapes', async () => {
    const set = (url: string) =>
      client.query(`UPDATE clubs SET google_review_url = $2 WHERE id = $1`, [club.clubId, url]);
    await set('https://g.page/r/CbX1abc_-9/review');
    await set('https://search.google.com/local/writereview?placeid=ChIJ123abc');
    await set('https://maps.app.goo.gl/AbCdEf123');
    for (const bad of [
      'https://www.google.com/url?q=https://evil.example',
      'https://www.google.com/amp/s/evil.example',
      'http://g.page/r/CbX1abc/review',
    ]) {
      expect((await failure(set(bad))).constraint, bad).toBe('clubs_google_review_url_sane');
    }
  });

  it('erases conversations and ratings with the record, and the purge empties all three', async () => {
    const id = await thread();
    await write(id, 'member');
    const { occurrenceId } = await makeOccurrence(client, club, { daysAhead: -1 });
    await checkIn(occurrenceId);
    await client.query(
      `INSERT INTO club_feedback (club_id, member_id, occurrence_id, rating) VALUES ($1, $2, $3, 4)`,
      [club.clubId, memberId, occurrenceId],
    );
    const count = async () =>
      (
        await client.query<{ n: number }>(
          `SELECT (SELECT count(*) FROM club_threads WHERE club_id = $1)
                + (SELECT count(*) FROM club_thread_messages WHERE club_id = $1)
                + (SELECT count(*) FROM club_feedback WHERE club_id = $1) AS n`,
          [club.clubId],
        )
      ).rows[0]?.n;
    expect(Number(await count())).toBe(3);
    await client.query(`DELETE FROM club_members WHERE id = $1`, [memberId]);
    expect(Number(await count())).toBe(0);

    memberId = await makeMember(client, club.clubId, 'Ана');
    const again = await thread();
    await write(again, 'club');
    await purgeClub(client, club.clubId);
    expect(Number(await count())).toBe(0);
  });
});

import { getDb, sql, type SQL } from '@sportkarta/db';
import {
  INQUIRIES_PER_ACCOUNT_PER_DAY,
  INQUIRIES_PER_DAY,
  MEMBER_MESSAGES_PER_DAY,
  NEW_THREADS_PER_DAY,
  type InquiryKind,
  type IsoDate,
  type ThreadKind,
} from '@sportkarta/lib/clubs';

import { clubRenderableSql, clubWritableGuard } from './access';
import { recordClubAudit } from './audit';
import { ensureSelfRecord } from './bookings';
import { noteLeadContacted, openLeadIfProspect } from './leads';
import { clubScope, clubWriteScope, memberSelfScope, type ClubActor } from './scope';

/**
 * The club's inbox (0052, wave F2 — 1club's inbox, anolla's quote requests).
 * A thread is between the club and ONE client record; only signed-in people
 * write. The office answers with inbox.reply (front of house) and may start
 * a thread only with a member who has a POPS account (the only way they can
 * read it); a member writes from the portal about their own record; a
 * visitor's inquiry from the club's page first gets them a record of their
 * own (the trial booking's path) and opens a lead.
 *
 * NOTICES: the caller enqueues one `inbox_message` job AFTER the commit, and
 * only when the other side had read the thread up to then (`notify`), so a
 * burst of five messages is one e-mail, not five. The worker sends it, and
 * the notice never carries what was written — only that there is something
 * to read.
 *
 * The club's messages show the club's name to the member, never the name of
 * the member of staff who wrote them.
 *
 * A MINOR's record has no conversation: the guardian is who the club writes
 * to (the broadcast rule), so neither side writes in one. An NGO admin reads
 * the inbox for support and never writes as the club.
 *
 * LOCK ORDER, everywhere here: the users row (ensureSelfRecord) → the member
 * row → the thread. The message trigger updates the thread, and marking a
 * prospect contacted updates the member row, so a writer that took the
 * thread first could deadlock against one that took the member first.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

const SOFIA_DAY_START = sql`(date_trunc('day', now() AT TIME ZONE 'Europe/Sofia') AT TIME ZONE 'Europe/Sofia')`;

export const INBOX_FILTERS = ['open', 'unread', 'inquiries', 'closed', 'all'] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

export interface ThreadSummary {
  id: string;
  memberId: string;
  memberName: string;
  kind: ThreadKind;
  subject: string;
  inquiryKind: InquiryKind | null;
  inquiryOn: IsoDate | null;
  partySize: number | null;
  /** Unread on the side that is looking. */
  unread: boolean;
  lastAt: string;
  closed: boolean;
}

export interface ThreadMessage {
  id: string;
  author: 'member' | 'club';
  /** The member of staff, for the office only; null on the member's side. */
  staffName: string | null;
  body: string;
  createdAt: string;
}

export interface ThreadDetail extends ThreadSummary {
  startedBy: 'member' | 'club';
  /** The member can read the club's answers (an active link to a POPS account). */
  memberLinked: boolean;
  messages: ThreadMessage[];
}

const LAST_AT = sql`greatest(th.created_at, th.last_member_at, th.last_club_at)`;
const CLUB_UNREAD = sql`(th.last_member_at IS NOT NULL
  AND (th.club_read_at IS NULL OR th.club_read_at < th.last_member_at))`;
const MEMBER_UNREAD = sql`(th.last_club_at IS NOT NULL
  AND (th.member_read_at IS NULL OR th.member_read_at < th.last_club_at))`;

function summary(row: Record<string, unknown>): ThreadSummary {
  return {
    id: String(row.id),
    memberId: String(row.member_id),
    memberName: String(row.member_name ?? ''),
    kind: row.kind === 'inquiry' ? 'inquiry' : 'message',
    subject: String(row.subject),
    inquiryKind: text(row.inquiry_kind) as InquiryKind | null,
    inquiryOn: text(row.inquiry_on) as IsoDate | null,
    partySize:
      row.party_size === null || row.party_size === undefined ? null : Number(row.party_size),
    unread: row.unread === true,
    lastAt: iso(row.last_at) ?? new Date(0).toISOString(),
    closed: row.closed_at !== null && row.closed_at !== undefined,
  };
}

const SUMMARY_COLUMNS = (unread: SQL) => sql`
  th.id, th.member_id, m.display_name AS member_name, th.kind, th.subject, th.inquiry_kind,
  to_char(th.inquiry_on, 'YYYY-MM-DD') AS inquiry_on, th.party_size, th.closed_at,
  ${unread} AS unread, ${LAST_AT} AS last_at`;

// ─── The office ─────────────────────────────────────────────────────────────

export async function listThreads(actor: ClubActor, filter: InboxFilter): Promise<ThreadSummary[]> {
  const where: Record<InboxFilter, SQL> = {
    open: sql`th.closed_at IS NULL`,
    unread: CLUB_UNREAD,
    inquiries: sql`th.kind = 'inquiry'`,
    closed: sql`th.closed_at IS NOT NULL`,
    all: sql`true`,
  };
  const result = await getDb().execute(sql`
    SELECT ${SUMMARY_COLUMNS(CLUB_UNREAD)}
      FROM club_threads th
      JOIN club_members m ON m.club_id = th.club_id AND m.id = th.member_id
     WHERE ${clubScope(actor, 'inbox.reply', 'th')} AND ${where[filter]}
     ORDER BY ${CLUB_UNREAD} DESC, ${LAST_AT} DESC
     LIMIT 200
  `);
  return result.rows.map(summary);
}

/** Threads with something the club has not read — the nav badge and the dashboard. */
export async function inboxUnreadCount(actor: ClubActor): Promise<number> {
  const result = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM club_threads th
     WHERE ${clubScope(actor, 'inbox.reply', 'th')} AND ${CLUB_UNREAD}
  `);
  return Number(result.rows[0]?.n ?? 0);
}

/** One record's threads, for its member page. */
export async function memberThreadsForStaff(
  actor: ClubActor,
  memberId: string,
): Promise<ThreadSummary[]> {
  const result = await getDb().execute(sql`
    SELECT ${SUMMARY_COLUMNS(CLUB_UNREAD)}
      FROM club_threads th
      JOIN club_members m ON m.club_id = th.club_id AND m.id = th.member_id
     WHERE ${clubScope(actor, 'inbox.reply', 'th')} AND th.member_id = ${memberId}::uuid
     ORDER BY ${LAST_AT} DESC
     LIMIT 50
  `);
  return result.rows.map(summary);
}

/** A thread shows its latest messages, oldest of them first. */
const MESSAGES_SHOWN = 500;

async function messagesOf(
  db: SqlRunner,
  clubId: string,
  threadId: string,
  forStaff: boolean,
): Promise<ThreadMessage[]> {
  const result = await db.execute(sql`
    SELECT * FROM (
      SELECT tm.id, tm.author, tm.body, tm.created_at,
             ${forStaff ? sql`coalesce(s.display_name, u.display_name)` : sql`NULL::text`} AS staff_name
        FROM club_thread_messages tm
        LEFT JOIN club_staff s ON s.club_id = tm.club_id AND s.user_id = tm.staff_user_id
        LEFT JOIN users u ON u.id = tm.staff_user_id
       WHERE tm.club_id = ${clubId}::uuid AND tm.thread_id = ${threadId}::uuid
       ORDER BY tm.created_at DESC, tm.id DESC
       LIMIT ${MESSAGES_SHOWN}
    ) latest
     ORDER BY created_at, id
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    author: row.author === 'club' ? 'club' : 'member',
    staffName: text(row.staff_name),
    body: String(row.body),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  }));
}

/**
 * The read marker moves to the newest message that was RENDERED, never to
 * now(): a message that lands between the read and the update stays unread
 * (and its notice is not swallowed). Taken from the row, not from a JS Date,
 * which would drop the microseconds and leave the marker just short of it.
 * Forward only.
 */
function readUpTo(
  marker: 'club_read_at' | 'member_read_at',
  clubId: string,
  messageId: string,
): SQL {
  return sql`${sql.raw(marker)} = greatest(coalesce(th.${sql.raw(marker)}, '-infinity'),
    (SELECT tm.created_at FROM club_thread_messages tm
      WHERE tm.club_id = ${clubId}::uuid AND tm.id = ${messageId}::uuid))`;
}

/**
 * A thread as the office reads it — and, by reading it, marks it read for
 * the club up to what it was shown. Marking read is a read marker, not club
 * data: the read scope is enough (a lapsed club may still read its mail). An
 * NGO admin who is not staff here reads without marking.
 */
export async function threadForStaff(
  actor: ClubActor,
  threadId: string,
): Promise<ThreadDetail | null> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT ${SUMMARY_COLUMNS(CLUB_UNREAD)}, th.started_by,
           EXISTS (SELECT 1 FROM club_member_links ml
                    WHERE ml.member_id = th.member_id AND ml.status = 'active') AS linked
      FROM club_threads th
      JOIN club_members m ON m.club_id = th.club_id AND m.id = th.member_id
     WHERE th.id = ${threadId}::uuid AND ${clubScope(actor, 'inbox.reply', 'th')}
  `);
  const row = result.rows[0];
  if (!row) return null;
  const messages = await messagesOf(db, actor.clubId, threadId, true);
  const newest = messages.at(-1);
  if (row.unread === true && actor.role !== null && newest) {
    await db.execute(sql`
      UPDATE club_threads th SET ${readUpTo('club_read_at', actor.clubId, newest.id)}
       WHERE th.id = ${threadId}::uuid AND ${clubScope(actor, 'inbox.reply', 'th')}
    `);
  }
  return {
    ...summary(row),
    startedBy: row.started_by === 'club' ? 'club' : 'member',
    memberLinked: row.linked === true,
    messages,
  };
}

export type InboxWriteError =
  | 'not_found'
  | 'readOnly'
  | 'not_linked'
  | 'minor_record'
  | 'too_many_messages'
  | 'claim_first'
  | 'link_pending';

export type InboxWriteResult =
  | { ok: true; threadId: string; messageId: string; notify: boolean }
  | { ok: false; error: InboxWriteError };

/**
 * The club answers. The member is told only if they had read everything the
 * club wrote before (else they have a notice to open already). Answering a
 * prospect's thread marks them contacted. The member row is locked before the
 * thread (the lock order above).
 */
export async function replyAsClub(
  db: TransactionalDb,
  actor: ClubActor,
  threadId: string,
  body: string,
): Promise<InboxWriteResult> {
  if (actor.role === null) return { ok: false, error: 'readOnly' };
  return db.transaction(async (tx) => {
    const member = await tx.execute(sql`
      SELECT m.id, m.is_minor, m.archived_at IS NOT NULL AS archived
        FROM club_members m
        JOIN club_threads th ON th.club_id = m.club_id AND th.member_id = m.id
       WHERE th.id = ${threadId}::uuid AND ${clubWriteScope(actor, 'inbox.reply', 'th')}
         FOR NO KEY UPDATE OF m
    `);
    const owner = member.rows[0];
    if (!owner) {
      const seen = await tx.execute(sql`
        SELECT ${clubWritableGuard(actor.clubId)} AS open
          FROM club_threads th
         WHERE th.id = ${threadId}::uuid AND ${clubScope(actor, 'inbox.reply', 'th')}
      `);
      const row = seen.rows[0];
      return { ok: false, error: row && row.open !== true ? 'readOnly' : 'not_found' } as const;
    }
    // An archived record cannot answer back (underDailyLimit), so the club
    // does not write into it either.
    if (owner.archived === true) return { ok: false, error: 'readOnly' } as const;
    if (owner.is_minor === true) return { ok: false, error: 'minor_record' } as const;
    const thread = await tx.execute(sql`
      SELECT th.member_id,
             (th.last_club_at IS NULL OR th.member_read_at >= th.last_club_at) AS member_caught_up
        FROM club_threads th
       WHERE th.id = ${threadId}::uuid AND ${clubWriteScope(actor, 'inbox.reply', 'th')}
       FOR UPDATE
    `);
    const row = thread.rows[0];
    if (!row) return { ok: false, error: 'not_found' } as const;
    const inserted = await tx.execute(sql`
      INSERT INTO club_thread_messages (club_id, thread_id, author, staff_user_id, body)
      VALUES (${actor.clubId}::uuid, ${threadId}::uuid, 'club', ${actor.userId}, ${body})
      RETURNING id
    `);
    await noteLeadContacted(tx, actor, String(row.member_id));
    return {
      ok: true,
      threadId,
      messageId: String(inserted.rows[0]?.id),
      notify: row.member_caught_up === true,
    } as const;
  });
}

/**
 * The office writes first — to a member with a POPS account only: anybody
 * else could never read it (the e-mail says there is a message, not what it
 * is). Never to a minor's record: the guardian is who the club writes to.
 */
export async function startThreadAsClub(
  db: TransactionalDb,
  actor: ClubActor,
  memberId: string,
  subject: string,
  body: string,
): Promise<InboxWriteResult> {
  if (actor.role === null) return { ok: false, error: 'readOnly' };
  return db.transaction(async (tx) => {
    const thread = await tx.execute(sql`
      INSERT INTO club_threads (club_id, member_id, kind, started_by, subject)
      SELECT m.club_id, m.id, 'message', 'club', ${subject}
        FROM club_members m
       WHERE m.id = ${memberId}::uuid AND ${clubWriteScope(actor, 'inbox.reply', 'm')}
         AND m.archived_at IS NULL AND NOT m.is_minor
         AND EXISTS (SELECT 1 FROM club_member_links ml
                      WHERE ml.member_id = m.id AND ml.status = 'active')
      RETURNING id
    `);
    const threadId = text(thread.rows[0]?.id);
    if (!threadId) {
      const known = await tx.execute(sql`
        SELECT m.is_minor, m.archived_at IS NOT NULL AS archived, ${clubWritableGuard(actor.clubId)} AS open
          FROM club_members m
         WHERE m.id = ${memberId}::uuid AND ${clubScope(actor, 'inbox.reply', 'm')}
      `);
      const record = known.rows[0];
      const error: InboxWriteError = !record
        ? 'not_found'
        : record.open !== true || record.archived === true
          ? 'readOnly'
          : record.is_minor === true
            ? 'minor_record'
            : 'not_linked';
      return { ok: false, error } as const;
    }
    const message = await tx.execute(sql`
      INSERT INTO club_thread_messages (club_id, thread_id, author, staff_user_id, body)
      VALUES (${actor.clubId}::uuid, ${threadId}::uuid, 'club', ${actor.userId}, ${body})
      RETURNING id
    `);
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'thread_started',
      subjectMemberId: memberId,
      detail: { threadId },
    });
    return { ok: true, threadId, messageId: String(message.rows[0]?.id), notify: true } as const;
  });
}

/** Close (done) or re-open a thread. A member writing re-opens it by itself. */
export async function setThreadClosed(
  db: TransactionalDb,
  actor: ClubActor,
  threadId: string,
  closed: boolean,
): Promise<boolean> {
  if (actor.role === null) return false;
  return db.transaction(async (tx) => {
    const changed = await tx.execute(sql`
      UPDATE club_threads th
         SET closed_at = ${closed ? sql`now()` : sql`NULL`},
             closed_by = ${closed ? actor.userId : null}
       WHERE th.id = ${threadId}::uuid AND ${clubWriteScope(actor, 'inbox.reply', 'th')}
         AND (th.closed_at IS NULL) = ${closed}
      RETURNING th.member_id
    `);
    const row = changed.rows[0];
    if (!row) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: closed ? 'thread_closed' : 'thread_reopened',
      subjectMemberId: String(row.member_id),
      detail: { threadId },
    });
    return true;
  });
}

// ─── The member ─────────────────────────────────────────────────────────────

/** The account's OWN record at the club (its active link) — threads are about it. */
const OWN_RECORD = (userId: string) => sql`EXISTS (
  SELECT 1 FROM club_member_links own
   WHERE own.member_id = m.id AND own.user_id = ${userId} AND own.status = 'active')`;

export async function memberThreads(userId: string, clubId: string): Promise<ThreadSummary[]> {
  const result = await getDb().execute(sql`
    SELECT ${SUMMARY_COLUMNS(MEMBER_UNREAD)}
      FROM club_threads th
      JOIN club_members m ON m.club_id = th.club_id AND m.id = th.member_id
     WHERE ${memberSelfScope(userId, clubId, 'm')} AND ${OWN_RECORD(userId)}
     ORDER BY ${MEMBER_UNREAD} DESC, ${LAST_AT} DESC
     LIMIT 100
  `);
  return result.rows.map(summary);
}

export async function memberUnreadCount(userId: string, clubId: string): Promise<number> {
  const result = await getDb().execute(sql`
    SELECT count(*)::int AS n
      FROM club_threads th
      JOIN club_members m ON m.club_id = th.club_id AND m.id = th.member_id
     WHERE ${memberSelfScope(userId, clubId, 'm')} AND ${OWN_RECORD(userId)} AND ${MEMBER_UNREAD}
  `);
  return Number(result.rows[0]?.n ?? 0);
}

/** Whether `threadId` is one of this person's own at the club (nothing is marked). */
export async function memberOwnsThread(
  userId: string,
  clubId: string,
  threadId: string,
): Promise<boolean> {
  const result = await getDb().execute(sql`
    SELECT 1 FROM club_threads th
      JOIN club_members m ON m.club_id = th.club_id AND m.id = th.member_id
     WHERE th.id = ${threadId}::uuid AND ${memberSelfScope(userId, clubId, 'm')}
       AND ${OWN_RECORD(userId)}
  `);
  return result.rows.length > 0;
}

/** A thread as its member reads it — marking it read for them. No staff names. */
export async function memberThread(
  userId: string,
  clubId: string,
  threadId: string,
): Promise<ThreadDetail | null> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT ${SUMMARY_COLUMNS(MEMBER_UNREAD)}, th.started_by, true AS linked
      FROM club_threads th
      JOIN club_members m ON m.club_id = th.club_id AND m.id = th.member_id
     WHERE th.id = ${threadId}::uuid AND ${memberSelfScope(userId, clubId, 'm')}
       AND ${OWN_RECORD(userId)}
  `);
  const row = result.rows[0];
  if (!row) return null;
  const messages = await messagesOf(db, clubId, threadId, false);
  const newest = messages.at(-1);
  if (row.unread === true && newest) {
    await db.execute(sql`
      UPDATE club_threads th SET ${readUpTo('member_read_at', clubId, newest.id)}
        FROM club_members m
       WHERE th.id = ${threadId}::uuid AND m.club_id = th.club_id AND m.id = th.member_id
         AND ${memberSelfScope(userId, clubId, 'm')} AND ${OWN_RECORD(userId)}
    `);
  }
  return {
    ...summary(row),
    startedBy: row.started_by === 'club' ? 'club' : 'member',
    memberLinked: true,
    messages,
  };
}

/**
 * Lock the writer's record and decide whether it may write now: not
 * archived, not a minor's, and under the day's caps — MEMBER_MESSAGES_PER_DAY
 * across all its threads and, for a new thread, NEW_THREADS_PER_DAY (a person
 * writing, not a script). The lock makes two tabs count one after the other.
 */
async function underDailyLimit(
  tx: SqlRunner,
  clubId: string,
  memberId: string,
  opensThread: boolean,
): Promise<InboxWriteError | null> {
  const record = await tx.execute(sql`
    SELECT is_minor, archived_at IS NOT NULL AS archived
      FROM club_members WHERE club_id = ${clubId}::uuid AND id = ${memberId}::uuid
       FOR NO KEY UPDATE
  `);
  const row = record.rows[0];
  if (!row || row.archived === true) return 'readOnly';
  if (row.is_minor === true) return 'minor_record';
  const today = await tx.execute(sql`
    SELECT (SELECT count(*)::int
              FROM club_thread_messages tm
              JOIN club_threads th ON th.club_id = tm.club_id AND th.id = tm.thread_id
             WHERE th.club_id = ${clubId}::uuid AND th.member_id = ${memberId}::uuid
               AND tm.author = 'member' AND tm.created_at >= ${SOFIA_DAY_START}) AS messages,
           (SELECT count(*)::int FROM club_threads th
             WHERE th.club_id = ${clubId}::uuid AND th.member_id = ${memberId}::uuid
               AND th.started_by = 'member' AND th.created_at >= ${SOFIA_DAY_START}) AS threads
  `);
  const counts = today.rows[0];
  if (Number(counts?.messages ?? 0) >= MEMBER_MESSAGES_PER_DAY) return 'too_many_messages';
  if (opensThread && Number(counts?.threads ?? 0) >= NEW_THREADS_PER_DAY) {
    return 'too_many_messages';
  }
  return null;
}

/**
 * The member writes: a new thread (`subject`) or an answer in one of theirs.
 * The office is told only when it had read the thread up to then.
 */
export async function writeAsMember(
  db: TransactionalDb,
  userId: string,
  clubId: string,
  target: { threadId: string } | { subject: string },
  body: string,
): Promise<InboxWriteResult> {
  return db.transaction(async (tx) => {
    const own = await tx.execute(sql`
      SELECT m.id FROM club_members m
       WHERE ${memberSelfScope(userId, clubId, 'm')} AND ${OWN_RECORD(userId)}
         AND m.archived_at IS NULL AND ${clubWritableGuard(clubId)}
    `);
    const memberId = text(own.rows[0]?.id);
    if (!memberId) return { ok: false, error: 'readOnly' } as const;
    const refused = await underDailyLimit(tx, clubId, memberId, !('threadId' in target));
    if (refused) return { ok: false, error: refused } as const;
    let threadId: string;
    let notify: boolean;
    if ('threadId' in target) {
      const thread = await tx.execute(sql`
        SELECT th.id,
               (th.last_member_at IS NULL OR th.club_read_at >= th.last_member_at) AS club_caught_up
          FROM club_threads th
         WHERE th.id = ${target.threadId}::uuid AND th.club_id = ${clubId}::uuid
           AND th.member_id = ${memberId}::uuid
         FOR UPDATE
      `);
      const row = thread.rows[0];
      if (!row) return { ok: false, error: 'not_found' } as const;
      threadId = String(row.id);
      notify = row.club_caught_up === true;
    } else {
      const created = await tx.execute(sql`
        INSERT INTO club_threads (club_id, member_id, kind, started_by, subject)
        VALUES (${clubId}::uuid, ${memberId}::uuid, 'message', 'member', ${target.subject})
        RETURNING id
      `);
      threadId = String(created.rows[0]?.id);
      notify = true;
      await recordClubAudit(tx, {
        clubId,
        by: { kind: 'member', userId },
        action: 'thread_started',
        subjectMemberId: memberId,
        detail: { threadId },
      });
    }
    const message = await tx.execute(sql`
      INSERT INTO club_thread_messages (club_id, thread_id, author, body)
      VALUES (${clubId}::uuid, ${threadId}::uuid, 'member', ${body})
      RETURNING id
    `);
    return { ok: true, threadId, messageId: String(message.rows[0]?.id), notify } as const;
  });
}

export interface InquiryInput {
  kind: InquiryKind;
  on: IsoDate | null;
  partySize: number | null;
  body: string;
}

/**
 * A visitor asks from the club's public page — signed in. Their own record
 * (found, or created as for a trial booking), a thread of kind inquiry, its
 * first message, and — for a prospect — a lead opened from the inquiry. At
 * most INQUIRIES_PER_DAY a day from one person to one club, and
 * INQUIRIES_PER_ACCOUNT_PER_DAY to all clubs together — counted under the
 * users row lock (ensureSelfRecord takes the same one), so two tabs count one
 * after the other, and BEFORE the record is found or made, so a refused
 * inquiry leaves no new record behind. `subject` is the inquiry kind's label
 * in the club's language, written by the caller.
 */
export async function sendInquiry(
  db: TransactionalDb,
  userId: string,
  clubId: string,
  input: InquiryInput,
  subject: string,
): Promise<InboxWriteResult> {
  return db.transaction(async (tx) => {
    const open = await tx.execute(sql`
      SELECT 1 FROM clubs c WHERE c.id = ${clubId}::uuid AND ${clubWritableGuard(clubId)}
    `);
    if (open.rows.length === 0) return { ok: false, error: 'readOnly' } as const;
    await tx.execute(sql`SELECT 1 FROM users WHERE id = ${userId} FOR NO KEY UPDATE`);
    const asked = await tx.execute(sql`
      SELECT count(*) FILTER (WHERE th.club_id = ${clubId}::uuid)::int AS here,
             count(*)::int AS everywhere
        FROM club_threads th
        JOIN club_member_links ml ON ml.member_id = th.member_id
       WHERE ml.user_id = ${userId} AND ml.status = 'active'
         AND th.kind = 'inquiry' AND th.created_at >= ${SOFIA_DAY_START}
    `);
    const counts = asked.rows[0];
    if (
      Number(counts?.here ?? 0) >= INQUIRIES_PER_DAY ||
      Number(counts?.everywhere ?? 0) >= INQUIRIES_PER_ACCOUNT_PER_DAY
    ) {
      return { ok: false, error: 'too_many_messages' } as const;
    }
    const self = await ensureSelfRecord(tx, userId, clubId);
    if (!self.ok) {
      return {
        ok: false,
        error: self.error === 'not_allowed' ? 'readOnly' : self.error,
      } as const;
    }
    const memberId = self.memberId;
    const refused = await underDailyLimit(tx, clubId, memberId, true);
    if (refused) return { ok: false, error: refused } as const;
    const created = await tx.execute(sql`
      INSERT INTO club_threads (club_id, member_id, kind, started_by, subject, inquiry_kind,
                                inquiry_on, party_size)
      VALUES (${clubId}::uuid, ${memberId}::uuid, 'inquiry', 'member', ${subject}, ${input.kind},
              ${input.on}::date, ${input.partySize})
      RETURNING id
    `);
    const threadId = String(created.rows[0]?.id);
    const message = await tx.execute(sql`
      INSERT INTO club_thread_messages (club_id, thread_id, author, body)
      VALUES (${clubId}::uuid, ${threadId}::uuid, 'member', ${input.body})
      RETURNING id
    `);
    await recordClubAudit(tx, {
      clubId,
      by: { kind: 'member', userId },
      action: 'inquiry_received',
      subjectMemberId: memberId,
      detail: { threadId, kind: input.kind },
    });
    await openLeadIfProspect(tx, clubId, memberId, 'inquiry', { kind: 'member', userId });
    return { ok: true, threadId, messageId: String(message.rows[0]?.id), notify: true } as const;
  });
}

/**
 * The club behind a public inquiry page: shown at all (renderable), taking
 * inquiries now (it may write), and its language — the subject is written in
 * it, as the club reads its inbox.
 */
export async function inquiryTarget(
  slug: string,
  locale: string,
): Promise<{ id: string; name: string; clubLocale: 'bg' | 'en'; open: boolean } | null> {
  if (!/^[a-z0-9-]{3,60}$/.test(slug)) return null;
  const result = await getDb().execute(sql`
    SELECT c.id, c.locale,
           CASE WHEN ${locale} = 'en' THEN coalesce(c.name_en, c.name_bg) ELSE c.name_bg END AS name
      FROM clubs c
     WHERE c.slug = ${slug} AND ${clubRenderableSql('c')}
  `);
  const row = result.rows[0];
  if (!row) return null;
  const id = String(row.id);
  return {
    id,
    name: String(row.name),
    clubLocale: row.locale === 'en' ? 'en' : 'bg',
    open: await clubTakesInquiries(id),
  };
}

/** Whether a club takes inquiries now: live, for the public page's button. */
export async function clubTakesInquiries(clubId: string): Promise<boolean> {
  const result = await getDb().execute(sql`
    SELECT 1 FROM clubs c WHERE c.id = ${clubId}::uuid AND ${clubWritableGuard(clubId)}
  `);
  return result.rows.length > 0;
}

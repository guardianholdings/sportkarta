import {
  LEAD_FIRST_CALL_HOURS,
  type ClubRole,
  type InquiryKind,
  type IsoDate,
  type ThreadKind,
} from '@sportkarta/lib/clubs';
import { sql, type SQL } from 'drizzle-orm';

import { clubWritableOn } from './messaging.js';

/**
 * What the worker needs for the inbox's notices and the staff's daily list of
 * prospects to call (0052). Read at SEND time — a job carries ids only.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export interface InboxNotice {
  messageId: string;
  clubId: string;
  threadId: string;
  memberId: string;
  author: 'member' | 'club';
  threadKind: ThreadKind;
  subject: string;
  inquiryKind: InquiryKind | null;
  inquiryOn: IsoDate | null;
  partySize: number | null;
  memberName: string;
  /** The prospect's owner among the staff (by value), if any. */
  assignedTo: string | null;
  /**
   * The other side read the thread past this message already — the notice
   * would only repeat what they saw.
   */
  alreadyRead: boolean;
}

/** One message of an active club's thread, as its notice needs it. */
export async function inboxNoticeOf(db: SqlRunner, messageId: string): Promise<InboxNotice | null> {
  const result = await db.execute(sql`
    SELECT tm.id, tm.club_id, tm.thread_id, tm.author, t.member_id, t.kind, t.subject,
           t.inquiry_kind, to_char(t.inquiry_on, 'YYYY-MM-DD') AS inquiry_on, t.party_size,
           m.display_name, m.lead_assigned_to,
           CASE WHEN tm.author = 'member' THEN t.club_read_at >= tm.created_at
                ELSE t.member_read_at >= tm.created_at END AS already_read
      FROM club_thread_messages tm
      JOIN club_threads t ON t.club_id = tm.club_id AND t.id = tm.thread_id
      JOIN club_members m ON m.club_id = t.club_id AND m.id = t.member_id
      JOIN clubs c ON c.id = tm.club_id AND c.status = 'active'
     WHERE tm.id = ${messageId}::uuid
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    messageId: String(row.id),
    clubId: String(row.club_id),
    threadId: String(row.thread_id),
    memberId: String(row.member_id),
    author: row.author === 'club' ? 'club' : 'member',
    threadKind: row.kind === 'inquiry' ? 'inquiry' : 'message',
    subject: String(row.subject),
    inquiryKind: text(row.inquiry_kind) as InquiryKind | null,
    inquiryOn: text(row.inquiry_on) as IsoDate | null,
    partySize:
      row.party_size === null || row.party_size === undefined ? null : Number(row.party_size),
    memberName: String(row.display_name),
    assignedTo: text(row.lead_assigned_to),
    alreadyRead: row.already_read === true,
  };
}

/** One member of staff's prospects to call today, at one club. */
export interface LeadsDue {
  clubId: string;
  userId: string;
  /** New prospects nobody has called for LEAD_FIRST_CALL_HOURS. */
  uncalled: number;
  /** Prospects whose agreed next step is today or overdue. */
  planned: number;
  /** Prospects due for either reason, each counted once. */
  due: number;
}

/**
 * The daily list (0052's «lead not contacted»): every open prospect — new or
 * contacted, never a won, lost, trial-booked or visited one — that nobody has
 * called for a day, or whose next step is due. A prospect with an owner goes
 * to that owner only; one without (or whose owner no longer holds `roles`)
 * goes to everybody who does. Clubs that may not write get no list.
 */
export async function leadsDue(
  db: SqlRunner,
  roles: readonly ClubRole[],
  today: IsoDate,
): Promise<LeadsDue[]> {
  const result = await db.execute(sql`
    WITH due AS (
      -- Uncalled: still at «new» a day on (a trial booking or a visit moves
      -- the card on by itself, and is not a call to make). Planned: any open
      -- card whose agreed next step is today or late.
      SELECT m.club_id, m.lead_assigned_to,
             (ls.stage = 'new'
              AND m.lead_opened_at < now() - make_interval(hours => ${LEAD_FIRST_CALL_HOURS}::int)) AS uncalled,
             coalesce(m.lead_next_action_on <= ${today}::date, false) AS planned
        FROM club_members m
        JOIN club_lead_stages ls ON ls.member_id = m.id
        JOIN clubs c ON c.id = m.club_id
       WHERE m.lead_opened_at IS NOT NULL AND m.archived_at IS NULL
         AND ls.stage NOT IN ('won', 'lost') AND ${clubWritableOn(today)}
    )
    SELECT d.club_id, s.user_id,
           count(*) FILTER (WHERE d.uncalled)::int AS uncalled,
           count(*) FILTER (WHERE d.planned)::int AS planned,
           count(*)::int AS due
      FROM due d
      JOIN club_staff s ON s.club_id = d.club_id AND s.role = ANY(${sql.param([...roles])}::text[])
     WHERE (d.uncalled OR d.planned)
       AND (s.user_id = d.lead_assigned_to
            OR NOT EXISTS (SELECT 1 FROM club_staff a
                            WHERE a.club_id = d.club_id AND a.user_id = d.lead_assigned_to
                              AND a.role = ANY(${sql.param([...roles])}::text[])))
     GROUP BY d.club_id, s.user_id
     ORDER BY d.club_id, s.user_id
  `);
  return result.rows.map((row) => ({
    clubId: String(row.club_id),
    userId: String(row.user_id),
    uncalled: Number(row.uncalled),
    planned: Number(row.planned),
    due: Number(row.due),
  }));
}

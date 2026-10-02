import { sql, type SQL } from 'drizzle-orm';

/**
 * Who hears about a moderation decision, resolved at SEND time (migration 0033).
 *
 * The web app enqueues `moderation.notify` with a decision id or a notice id —
 * never an address, for the reason session mail gives: a job row outlives the
 * account it names, and an archived queue is no place for a mailing list. These
 * reads turn the id into an inbox at the moment of sending, so an account erased
 * in between simply resolves to nobody, and a notifier contact the retention
 * sweep already erased resolves to nobody too.
 *
 * No display name is read anywhere here: the mail greets without one. That also
 * keeps this file outside the consent registry's concern (consent-registry.test
 * — nothing here names a person on a public surface, or at all).
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

/** A refusal and the member it restricted. */
export interface DecisionMailTarget {
  decisionId: number;
  kind: 'photo_rejected' | 'photo_removed' | 'facility_removed';
  email: string;
  reason: string | null;
  facilityName: string | null;
  /** Only while the facility is still public — a removed one has no page. */
  facilitySlug: string | null;
  /** `DD.MM.YYYY`, civil Sofia date. */
  decidedOn: string;
}

/**
 * The member a refusal restricted, or null when there is nobody to tell.
 *
 * ONLY REFUSALS: a photo rejected in the queue, a published one taken down
 * (0032's 'removed'), a facility marked gone. An approved photo or a verified
 * facility restricts nothing, and Art. 17 is about restrictions; the join below
 * simply matches no other kind.
 *
 * WHO. A photo's uploader is `facility_photos.uploaded_by` (NULL for the
 * anonymous report flow — nobody to tell). A crowd facility's author is the
 * account on its `created` edit (apps/web/lib/contributions/add-facility.ts); an
 * OSM or municipal row has no such edit, so marking one gone tells nobody,
 * which is right — no member wrote it.
 */
export async function decisionMailTarget(
  db: SqlRunner,
  decisionId: number,
): Promise<DecisionMailTarget | null> {
  const result = await db.execute(sql`
    SELECT d.id, d.target_type, d.decision::text AS decision, d.reason, f.name AS facility_name,
           CASE WHEN f.status <> 'gone' THEN f.slug END AS facility_slug,
           to_char(d.decided_at AT TIME ZONE 'Europe/Sofia', 'DD.MM.YYYY') AS decided_on,
           u.email
      FROM moderation_decisions d
      JOIN facilities f ON f.id = d.facility_id
      JOIN users u ON u.id = CASE d.target_type
             WHEN 'photo' THEN (SELECT p.uploaded_by FROM facility_photos p WHERE p.id = d.target_id)
             WHEN 'facility' THEN (
               SELECT e.actor FROM facility_edits e
                WHERE e.facility_id = d.facility_id AND e.field = 'created'
                  AND e.source = 'crowd' AND e.actor IS NOT NULL
                ORDER BY e.created_at, e.id
                LIMIT 1)
           END
     WHERE d.id = ${decisionId}
       AND ((d.target_type = 'photo' AND d.decision::text IN ('rejected', 'removed'))
         OR (d.target_type = 'facility' AND d.decision::text = 'gone'))
  `);
  const row = result.rows[0];
  if (!row || typeof row.email !== 'string' || row.email.trim() === '') return null;
  return {
    decisionId: Number(row.id),
    kind:
      row.target_type === 'facility'
        ? 'facility_removed'
        : row.decision === 'removed'
          ? 'photo_removed'
          : 'photo_rejected',
    email: row.email,
    reason: (row.reason as string | null) ?? null,
    facilityName: (row.facility_name as string | null) ?? null,
    facilitySlug: (row.facility_slug as string | null) ?? null,
    decidedOn: String(row.decided_on),
  };
}

/**
 * A notice and the address its sender left, if any.
 *
 * NOTHING THE NOTIFIER WROTE is here — not the reported URL, not the
 * explanation. The reply address is whatever an anonymous form was given, with
 * no proof it belongs to the sender, so a mail that echoed the notifier's words
 * would let anybody have POPS send anybody a branded message with a link of
 * their choosing in it. The notice is identified by what is OURS: the day it
 * arrived and its category from the closed list.
 */
export interface NoticeMailTarget {
  noticeId: string;
  email: string;
  /** A `content_notice_category` slug; the label lives in messages/*.json. */
  category: string;
  status: 'pending' | 'actioned' | 'dismissed';
  reason: string | null;
  /** `DD.MM.YYYY`, civil Sofia date. */
  receivedOn: string;
  decidedOn: string | null;
}

/** The notifier's reply address for one notice, or null when they left none. */
export async function noticeMailTarget(
  db: SqlRunner,
  noticeId: string,
): Promise<NoticeMailTarget | null> {
  const result = await db.execute(sql`
    SELECT id, notifier_email, category::text AS category, status, decision_reason,
           to_char(created_at AT TIME ZONE 'Europe/Sofia', 'DD.MM.YYYY') AS received_on,
           to_char(decided_at AT TIME ZONE 'Europe/Sofia', 'DD.MM.YYYY') AS decided_on
      FROM content_notices
     WHERE id = ${noticeId}::uuid AND notifier_email IS NOT NULL
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    noticeId: String(row.id),
    email: String(row.notifier_email),
    category: String(row.category),
    status: row.status as NoticeMailTarget['status'],
    reason: (row.decision_reason as string | null) ?? null,
    receivedOn: String(row.received_on),
    decidedOn: (row.decided_on as string | null) ?? null,
  };
}

export type ModerationNotificationSubject =
  | { kind: 'decision'; decisionId: number }
  | { kind: 'notice_received' | 'notice_decided'; noticeId: string };

/**
 * Claim the right to send one moderation mail. True = this caller sends it;
 * false = somebody already did. Call inside the SAME transaction as the send,
 * before it, exactly like `claimNotification` for session mail: a failed send
 * rolls the claim back and the next run retries.
 */
export async function claimModerationNotification(
  db: SqlRunner,
  subject: ModerationNotificationSubject,
): Promise<boolean> {
  const result =
    subject.kind === 'decision'
      ? await db.execute(sql`
          INSERT INTO moderation_notifications (kind, decision_id)
          VALUES ('decision', ${subject.decisionId})
          ON CONFLICT DO NOTHING
          RETURNING id
        `)
      : await db.execute(sql`
          INSERT INTO moderation_notifications (kind, notice_id)
          VALUES (${subject.kind}::moderation_notification_kind, ${subject.noticeId}::uuid)
          ON CONFLICT DO NOTHING
          RETURNING id
        `);
  return result.rows.length > 0;
}

/**
 * How long a notifier's name and address outlive the decision on their notice.
 * Long enough to answer a follow-up or a contested outcome; short enough that
 * the notice table does not become a list of people who complained. The
 * figure is printed on /privacy — change both together.
 */
export const NOTIFIER_CONTACT_RETENTION_DAYS = 180;

/**
 * Erase notifier contacts past retention. Returns how many notices lost theirs.
 * The guard trigger (0033) allows exactly this mutation on a decided notice.
 */
export async function eraseExpiredNotifierContacts(
  db: SqlRunner,
  days: number = NOTIFIER_CONTACT_RETENTION_DAYS,
): Promise<number> {
  const result = await db.execute(sql`
    UPDATE content_notices
       SET notifier_name = NULL, notifier_email = NULL
     WHERE status <> 'pending'
       AND decided_at < now() - make_interval(days => ${days})
       AND (notifier_name IS NOT NULL OR notifier_email IS NOT NULL)
    RETURNING id
  `);
  return result.rows.length;
}

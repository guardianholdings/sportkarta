import { getDb, sql, type SQL } from '@sportkarta/db';
import {
  FEEDBACK_WINDOW_DAYS,
  PASSPORT_CHECKIN_METHODS,
  PUBLIC_RATING_MONTHS,
  publicRatingVisible,
  roundRating,
} from '@sportkarta/lib/clubs';

import { clubWritableGuard } from './access';
import { recordClubAudit } from './audit';
import { violatedConstraint } from './errors';
import { clubFeatureSql } from './features';
import { clubActorMay, clubScope, memberSelfScope, type ClubActor } from './scope';

/**
 * Ratings (0052, wave F2 — 1club's and anolla's feedback, reputation
 * management). A member rates a class they CAME to, or a court / appointment
 * of theirs that is over — the club_feedback_attended trigger admits nobody
 * else, and records the trainer itself — within FEEDBACK_WINDOW_DAYS, once,
 * from the portal. The comment is the club's to read (feedback.view,
 * management) and never public; the club's page shows the AVERAGE only, and
 * only from PUBLIC_RATING_MIN_COUNT ratings in PUBLIC_RATING_MONTHS, counting
 * only classes the member scanned into (a QR or card check-in — a desk tick
 * or a booking the club wrote itself is the club's word, and the public
 * figure must not be). After EVERY rating, good or bad, the member is shown
 * the club's own Google review link, if it set one — never only after good
 * ones (review gating); a plain link; nothing about the member goes to Google.
 *
 * Feature `feedback` (standard and up).
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

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

/** The account's own record at the club — a member rates for themselves. */
const OWN_RECORD = (userId: string) => sql`EXISTS (
  SELECT 1 FROM club_member_links own
   WHERE own.member_id = m.id AND own.user_id = ${userId} AND own.status = 'active')`;

export interface FeedbackDue {
  kind: 'class' | 'booking';
  /** The occurrence or the reservation. */
  id: string;
  title: string;
  startsAt: string;
}

/** What the member may still rate: their classes and bookings of the last two weeks. */
export async function feedbackToGive(
  userId: string,
  clubId: string,
  locale: string,
): Promise<FeedbackDue[]> {
  const window = sql`make_interval(days => ${FEEDBACK_WINDOW_DAYS}::int)`;
  const result = await getDb().execute(sql`
    SELECT 'class' AS kind, o.id, k.title, o.starts_at
      FROM club_members m
      JOIN club_checkins ci ON ci.club_id = m.club_id AND ci.member_id = m.id
      JOIN club_class_occurrences o ON o.club_id = ci.club_id AND o.id = ci.occurrence_id
      JOIN club_classes k ON k.club_id = o.club_id AND k.id = o.class_id
     WHERE ${memberSelfScope(userId, clubId, 'm')} AND ${OWN_RECORD(userId)}
       AND ${clubFeatureSql(clubId, 'feedback')}
       AND o.ends_at <= now() AND o.ends_at > now() - ${window}
       AND NOT EXISTS (SELECT 1 FROM club_feedback f
                        WHERE f.club_id = m.club_id AND f.member_id = m.id AND f.occurrence_id = o.id)
    UNION ALL
    SELECT 'booking' AS kind, r.id,
           CASE WHEN ${locale} = 'en' THEN coalesce(sv.name_en, sv.name_bg) ELSE sv.name_bg END,
           r.starts_at
      FROM club_members m
      JOIN club_reservations r ON r.club_id = m.club_id AND r.member_id = m.id
      JOIN club_services sv ON sv.club_id = r.club_id AND sv.id = r.service_id
     WHERE ${memberSelfScope(userId, clubId, 'm')} AND ${OWN_RECORD(userId)}
       AND ${clubFeatureSql(clubId, 'feedback')}
       AND r.state = 'confirmed' AND r.ends_at <= now() AND r.ends_at > now() - ${window}
       AND NOT EXISTS (SELECT 1 FROM club_feedback f
                        WHERE f.club_id = m.club_id AND f.member_id = m.id AND f.reservation_id = r.id)
     ORDER BY starts_at DESC
     LIMIT 30
  `);
  return result.rows.map((row) => ({
    kind: row.kind === 'booking' ? 'booking' : 'class',
    id: String(row.id),
    title: String(row.title ?? ''),
    startsAt: iso(row.starts_at),
  }));
}

export interface FeedbackInput {
  subject: { kind: 'class'; occurrenceId: string } | { kind: 'booking'; reservationId: string };
  rating: number;
  comment: string | null;
}

export type FeedbackResult =
  | { ok: true; googleReviewUrl: string | null }
  | { ok: false; error: 'not_allowed' | 'already_rated' | 'not_attended' };

/** The member's rating, once per class or booking, inside the window. */
export async function giveFeedback(
  db: TransactionalDb,
  userId: string,
  clubId: string,
  input: FeedbackInput,
): Promise<FeedbackResult> {
  const window = sql`make_interval(days => ${FEEDBACK_WINDOW_DAYS}::int)`;
  const insert =
    input.subject.kind === 'class'
      ? sql`
        INSERT INTO club_feedback (club_id, member_id, occurrence_id, rating, comment)
        SELECT m.club_id, m.id, o.id, ${input.rating}, ${input.comment}
          FROM club_members m
          JOIN club_class_occurrences o ON o.club_id = m.club_id AND o.id = ${input.subject.occurrenceId}::uuid
         WHERE ${memberSelfScope(userId, clubId, 'm')} AND ${OWN_RECORD(userId)}
           AND ${clubWritableGuard(clubId)} AND ${clubFeatureSql(clubId, 'feedback')}
           AND o.ends_at <= now() AND o.ends_at > now() - ${window}
        RETURNING id`
      : sql`
        INSERT INTO club_feedback (club_id, member_id, reservation_id, rating, comment)
        SELECT m.club_id, m.id, r.id, ${input.rating}, ${input.comment}
          FROM club_members m
          JOIN club_reservations r ON r.club_id = m.club_id AND r.id = ${input.subject.reservationId}::uuid
         WHERE ${memberSelfScope(userId, clubId, 'm')} AND ${OWN_RECORD(userId)}
           AND ${clubWritableGuard(clubId)} AND ${clubFeatureSql(clubId, 'feedback')}
           AND r.ends_at > now() - ${window}
        RETURNING id`;
  try {
    return await db.transaction(async (tx) => {
      const inserted = await tx.execute(insert);
      if (inserted.rows.length === 0) return { ok: false, error: 'not_allowed' } as const;
      const club = await tx.execute(sql`
        SELECT google_review_url FROM clubs WHERE id = ${clubId}::uuid
      `);
      return { ok: true, googleReviewUrl: text(club.rows[0]?.google_review_url) };
    });
  } catch (error: unknown) {
    switch (violatedConstraint(error)) {
      case 'club_feedback_occurrence_unique':
      case 'club_feedback_reservation_unique':
        return { ok: false, error: 'already_rated' };
      case 'club_feedback_attended':
        return { ok: false, error: 'not_attended' };
      default:
        throw error;
    }
  }
}

export interface RatingGroup {
  /** The class or the trainer — a stable key, two may share a label. */
  id: string;
  label: string;
  count: number;
  average: number;
}

export interface FeedbackOverview {
  count: number;
  average: number | null;
  /** How many of each star, 1 to 5. */
  distribution: [number, number, number, number, number];
  byClass: RatingGroup[];
  byTrainer: RatingGroup[];
  recent: {
    id: string;
    memberId: string;
    memberName: string;
    subject: string;
    rating: number;
    comment: string | null;
    createdAt: string;
  }[];
  googleReviewUrl: string | null;
  /** The public average is shown (enough ratings, and the feature on). */
  publicShown: boolean;
}

/** The office's view of its ratings over PUBLIC_RATING_MONTHS, comments included. */
export async function feedbackOverview(
  actor: ClubActor,
  locale: string,
): Promise<FeedbackOverview | null> {
  const db = getDb();
  const club = await db.execute(sql`
    SELECT c.google_review_url FROM clubs c
     WHERE c.id = ${actor.clubId}::uuid AND ${clubActorMay(actor, 'feedback.view', { write: false })}
  `);
  if (club.rows.length === 0) return null;
  const since = sql`now() - make_interval(months => ${PUBLIC_RATING_MONTHS}::int)`;
  const totals = await db.execute(sql`
    SELECT count(*)::int AS n, avg(fb.rating)::float8 AS average,
           count(*) FILTER (WHERE fb.rating = 1)::int AS r1,
           count(*) FILTER (WHERE fb.rating = 2)::int AS r2,
           count(*) FILTER (WHERE fb.rating = 3)::int AS r3,
           count(*) FILTER (WHERE fb.rating = 4)::int AS r4,
           count(*) FILTER (WHERE fb.rating = 5)::int AS r5
      FROM club_feedback fb
     WHERE ${clubScope(actor, 'feedback.view', 'fb')} AND fb.created_at > ${since}
  `);
  const t = totals.rows[0] ?? {};
  const byClass = await db.execute(sql`
    SELECT k.id::text AS id, k.title AS label, count(*)::int AS n, avg(fb.rating)::float8 AS average
      FROM club_feedback fb
      JOIN club_class_occurrences o ON o.club_id = fb.club_id AND o.id = fb.occurrence_id
      JOIN club_classes k ON k.club_id = o.club_id AND k.id = o.class_id
     WHERE ${clubScope(actor, 'feedback.view', 'fb')} AND fb.created_at > ${since}
     GROUP BY k.id, k.title
     ORDER BY count(*) DESC, k.title
     LIMIT 50
  `);
  const byTrainer = await db.execute(sql`
    SELECT fb.instructor_user_id::text AS id,
           coalesce(s.display_name, u.display_name, '') AS label, count(*)::int AS n,
           avg(fb.rating)::float8 AS average
      FROM club_feedback fb
      LEFT JOIN club_staff s ON s.club_id = fb.club_id AND s.user_id = fb.instructor_user_id
      LEFT JOIN users u ON u.id = fb.instructor_user_id
     WHERE ${clubScope(actor, 'feedback.view', 'fb')} AND fb.created_at > ${since}
       AND fb.instructor_user_id IS NOT NULL
     GROUP BY fb.instructor_user_id, s.display_name, u.display_name
     ORDER BY count(*) DESC
     LIMIT 50
  `);
  const recent = await db.execute(sql`
    SELECT fb.id, fb.member_id, m.display_name, fb.rating, fb.comment, fb.created_at,
           coalesce(k.title,
                    CASE WHEN ${locale} = 'en' THEN coalesce(sv.name_en, sv.name_bg) ELSE sv.name_bg END,
                    '') AS subject
      FROM club_feedback fb
      JOIN club_members m ON m.club_id = fb.club_id AND m.id = fb.member_id
      LEFT JOIN club_class_occurrences o ON o.club_id = fb.club_id AND o.id = fb.occurrence_id
      LEFT JOIN club_classes k ON k.club_id = o.club_id AND k.id = o.class_id
      LEFT JOIN club_reservations r ON r.club_id = fb.club_id AND r.id = fb.reservation_id
      LEFT JOIN club_services sv ON sv.club_id = r.club_id AND sv.id = r.service_id
     WHERE ${clubScope(actor, 'feedback.view', 'fb')}
     ORDER BY fb.created_at DESC
     LIMIT 50
  `);
  const group = (row: Record<string, unknown>): RatingGroup => ({
    id: String(row.id),
    label: String(row.label ?? ''),
    count: Number(row.n),
    average: roundRating(Number(row.average)),
  });
  const count = Number(t.n ?? 0);
  return {
    count,
    average: count > 0 ? roundRating(Number(t.average)) : null,
    distribution: [
      Number(t.r1 ?? 0),
      Number(t.r2 ?? 0),
      Number(t.r3 ?? 0),
      Number(t.r4 ?? 0),
      Number(t.r5 ?? 0),
    ],
    byClass: byClass.rows.map(group),
    byTrainer: byTrainer.rows.map(group),
    recent: recent.rows.map((row) => ({
      id: String(row.id),
      memberId: String(row.member_id),
      memberName: String(row.display_name),
      subject: String(row.subject),
      rating: Number(row.rating),
      comment: text(row.comment),
      createdAt: iso(row.created_at),
    })),
    googleReviewUrl: text(club.rows[0]?.google_review_url),
    publicShown: (await publicRating(actor.clubId)) !== null,
  };
}

/**
 * The club page's line: the average and the count over PUBLIC_RATING_MONTHS,
 * or null — too few ratings to show without exposing one, or a tier without
 * feedback. Public data: no scope, the club id is the page's.
 *
 * Only ratings of a class the member SCANNED into count (PASSPORT_CHECKIN_
 * METHODS, the passport's rule): the club can type a record, tick it in at
 * the desk or book it a court, so those ratings stay in its office figures
 * and out of the number strangers read.
 */
export async function publicRating(
  clubId: string,
): Promise<{ average: number; count: number } | null> {
  const result = await getDb().execute(sql`
    SELECT count(*)::int AS n, avg(f.rating)::float8 AS average
      FROM club_feedback f
     WHERE f.club_id = ${clubId}::uuid AND ${clubFeatureSql(clubId, 'feedback')}
       AND f.created_at > now() - make_interval(months => ${PUBLIC_RATING_MONTHS}::int)
       AND f.occurrence_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM club_checkins ci
          WHERE ci.club_id = f.club_id AND ci.member_id = f.member_id
            AND ci.occurrence_id = f.occurrence_id
            AND ci.method = ANY(${sql.param([...PASSPORT_CHECKIN_METHODS])}::text[]))
  `);
  const row = result.rows[0];
  const count = Number(row?.n ?? 0);
  if (!row || !publicRatingVisible(count)) return null;
  return { average: roundRating(Number(row.average)), count };
}

/** The club's own Google review link, for the page a member lands on after rating. */
export async function googleReviewUrlOf(clubId: string): Promise<string | null> {
  const result = await getDb().execute(sql`
    SELECT c.google_review_url FROM clubs c
     WHERE c.id = ${clubId}::uuid AND ${clubFeatureSql(clubId, 'feedback')}
  `);
  return text(result.rows[0]?.google_review_url);
}

/** The club's own Google review link (settings.manage); null removes it. */
export async function saveGoogleReviewUrl(
  db: TransactionalDb,
  actor: ClubActor,
  url: string | null,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const saved = await tx.execute(sql`
      UPDATE clubs c SET google_review_url = ${url}, updated_at = now()
       WHERE c.id = ${actor.clubId}::uuid
         AND ${clubActorMay(actor, 'settings.manage', { write: true })}
         AND ${clubFeatureSql(actor.clubId, 'feedback')}
      RETURNING c.id
    `);
    if (saved.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'feedback_settings_changed',
      detail: { googleReviewUrl: url !== null },
    });
    return true;
  });
}

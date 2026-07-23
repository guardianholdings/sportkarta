import { sql, type SQL } from 'drizzle-orm';

/**
 * Who to tell about a play session, and what we have already told them
 * (docs/ROADMAP.md §6, Stage 4.2).
 *
 * This lives in the db package rather than apps/web/lib because BOTH the worker
 * and the web app need it — the worker sends reminders and cancellations, the
 * web app sends confirmations — and a second implementation of "who is going"
 * would be a second answer to a question Stage 4.1 arranged to have exactly one
 * answer to.
 *
 * THE IDEMPOTENCY CONTRACT. `claimNotification` inserts into the ledger and
 * reports whether it was the one that inserted. Callers send only on `true`,
 * inside the same transaction, BEFORE the SMTP handoff — so a throw rolls the
 * claim back and the next run retries, while a success can never be repeated.
 *
 * ADDRESSES ARE READ HERE AND NOWHERE ELSE. They are never put into a pg-boss
 * job payload: a job row outlives the account it names, and an archived queue
 * is a strange place for a mailing list. Jobs carry occurrence ids and account
 * ids; this file turns them into an inbox at the moment of sending.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export type SessionNotificationKind =
  | 'rsvp_confirmed'
  | 'rsvp_waitlisted'
  | 'promoted'
  | 'reminder_24h'
  | 'reminder_2h'
  | 'occurrence_cancelled';

/** Everything a session email needs, for one member and one occurrence. */
export interface SessionMailRecipient {
  occurrenceId: string;
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  title: string;
  sport: string;
  /** Sofia wall clock, `YYYY-MM-DDTHH:MM:SS`. Never re-converted downstream. */
  startsAtLocal: string;
  startsAt: string;
  facilityName: string | null;
  facilitySlug: string | null;
  capacity: number | null;
  going: number;
  position: number;
  rsvpStatus: 'going' | 'waitlisted';
  /**
   * The arrival ticket behind this RSVP. Withdrawing and re-joining draws a
   * fresh one (migration 0008), which is what lets the notification ledger tell
   * "already confirmed" apart from "confirmed for a sign-up they have since
   * withdrawn and made again".
   */
  rsvpSeq: number;
  /** The member's private feed token, when they have minted one. */
  calendarToken: string | null;
}

/**
 * The one projection every notification path uses. Written once because the
 * reminder query, the cancellation query and the confirmation query differ ONLY
 * in their WHERE clause — and the failure mode of writing them separately is a
 * reminder that says "4 going" while the confirmation says "5".
 */
function recipientColumns(): SQL {
  return sql`
    o.id AS occurrence_id,
    o.session_id,
    o.starts_at,
    -- Formatted in SQL, not in JS. A timestamp WITHOUT time zone comes back
    -- from node-postgres as a Date built in the PROCESS zone, so a Sofia wall
    -- clock read by a TZ=UTC worker would arrive three hours out and every
    -- reminder would name the wrong hour. to_char keeps it a string of digits.
    to_char(o.starts_at_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at_local,
    s.title,
    s.sport,
    s.capacity::int AS capacity,
    f.name AS facility_name,
    f.slug AS facility_slug,
    u.id AS user_id,
    u.email,
    u.display_name,
    ct.token AS calendar_token,
    pos.position::int AS position,
    pos.seq AS rsvp_seq,
    pos.rsvp_status,
    (SELECT count(*)::int FROM play_session_rsvp_positions g
      WHERE g.occurrence_id = o.id AND g.rsvp_status = 'going') AS going
  `;
}

function recipientJoins(): SQL {
  return sql`
    FROM play_session_occurrences o
    JOIN play_sessions s ON s.id = o.session_id
    JOIN facilities f ON f.id = s.facility_id
    JOIN play_session_rsvp_positions pos ON pos.occurrence_id = o.id
    JOIN users u ON u.id = pos.user_id
    LEFT JOIN calendar_tokens ct ON ct.user_id = u.id
  `;
}

function toRecipient(row: Record<string, unknown>): SessionMailRecipient {
  return {
    occurrenceId: String(row.occurrence_id),
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    email: String(row.email),
    displayName: String(row.display_name ?? ''),
    title: String(row.title),
    sport: String(row.sport),
    // `timestamp without time zone` comes back from node-postgres as a Date in
    // the PROCESS zone, which would shift a Sofia wall clock by the container's
    // offset. The column is cast to text in SQL instead — see the queries.
    startsAtLocal: String(row.starts_at_local),
    startsAt: new Date(row.starts_at as string | number | Date).toISOString(),
    facilityName: (row.facility_name as string | null) ?? null,
    facilitySlug: (row.facility_slug as string | null) ?? null,
    capacity: row.capacity === null || row.capacity === undefined ? null : Number(row.capacity),
    going: Number(row.going ?? 0),
    position: Number(row.position ?? 0),
    rsvpStatus: row.rsvp_status === 'waitlisted' ? 'waitlisted' : 'going',
    // bigint arrives as a string from node-postgres; these are small counters.
    rsvpSeq: Number(row.rsvp_seq ?? 0),
    calendarToken: (row.calendar_token as string | null) ?? null,
  };
}

/**
 * The three kinds that are about ONE SIGN-UP rather than about the occurrence.
 * They are keyed by the arrival ticket, so withdrawing and re-joining is
 * confirmed again — and, crucially, can be PROMOTED again. Under a flat key the
 * second promotion is silently swallowed, and somebody who was let back in off
 * the waitlist is never told and does not turn up.
 */
const RSVP_SCOPED_KINDS: ReadonlySet<SessionNotificationKind> = new Set([
  'rsvp_confirmed',
  'rsvp_waitlisted',
  'promoted',
]);

/**
 * Claim the right to send. Returns false when this exact notification has
 * already gone — a retried job, an overlapping schedule, a second worker, or
 * two concurrent withdrawals both computing the same promotion.
 *
 * That last case is why promotion detection is allowed to be racy upstream: the
 * ledger makes a duplicate computation harmless, so the withdrawal path does
 * not need a lock on a derived view.
 *
 * `ON CONFLICT DO NOTHING` carries no target: there are two partial unique
 * indexes (see migration 0013) and which one applies is decided by the kind. An
 * inference clause would have to name one and would silently stop protecting
 * the other half.
 */
export async function claimNotification(
  db: SqlRunner,
  occurrenceId: string,
  userId: string,
  kind: SessionNotificationKind,
  rsvpSeq: number | null,
): Promise<boolean> {
  const rsvpScoped = RSVP_SCOPED_KINDS.has(kind);
  if (rsvpScoped && (rsvpSeq === null || !Number.isFinite(rsvpSeq))) {
    // The CHECK would refuse this anyway; failing here says why.
    throw new Error(`notification kind ${kind} requires the RSVP arrival ticket`);
  }
  const seq = rsvpScoped ? rsvpSeq : null;
  const result = await db.execute(sql`
    INSERT INTO play_session_notifications (occurrence_id, user_id, kind, rsvp_seq)
    VALUES (${occurrenceId}::uuid, ${userId}, ${kind}::play_session_notification_kind, ${seq})
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  return result.rows.length > 0;
}

/** The two reminder lead times, as the roadmap names them. */
export const REMINDER_LEAD_HOURS = { reminder_24h: 24, reminder_2h: 2 } as const;

export type ReminderKind = keyof typeof REMINDER_LEAD_HOURS;

/**
 * Who is due a reminder, right now.
 *
 * NOT "starting in 24 h ± 5 minutes". That query mails nobody at all for any
 * session whose window the job slept through — a deploy, a restart, a slow
 * queue — and leaves no trace that it did not. This one asks "starting within
 * the lead time and not yet told", which is self-healing after downtime and
 * cannot double-send, because the ledger is the guard.
 *
 * Three conditions are worth spelling out:
 *
 *  - `rsvp_status = 'going'` only. Telling somebody on the waitlist that "your
 *    session starts in two hours" is a promise we have not made; if a spot
 *    opens they get the `promoted` mail instead.
 *  - The 24 h reminder stops at the 2 h mark, so a member who signs up ninety
 *    minutes before kick-off gets one message rather than two at once.
 *  - `pos.created_at <= o.starts_at - <lead>` — you only get a "24 hours to go"
 *    reminder if you signed up MORE than 24 hours before. Otherwise the
 *    confirmation email, sent seconds earlier, already told you when it is.
 */
export async function dueReminders(
  db: SqlRunner,
  kind: ReminderKind,
  limit = 500,
): Promise<SessionMailRecipient[]> {
  // make_interval with a bound parameter rather than an interpolated literal:
  // the value is a typed constant today, and sql.raw is how that stops being
  // true without anybody noticing.
  const lead = sql`make_interval(hours => ${REMINDER_LEAD_HOURS[kind]})`;
  const floor =
    kind === 'reminder_24h'
      ? // Below two hours the 2 h reminder is the right message.
        sql`AND o.starts_at > now() + interval '2 hours'`
      : sql``;

  const result = await db.execute(sql`
    SELECT ${recipientColumns()}
    ${recipientJoins()}
    WHERE o.status = 'scheduled'
      AND s.status = 'scheduled'
      AND o.starts_at > now()
      AND o.starts_at <= now() + ${lead}
      ${floor}
      AND pos.rsvp_status = 'going'
      AND pos.created_at <= o.starts_at - ${lead}
      AND NOT EXISTS (
        SELECT 1 FROM play_session_notifications n
         WHERE n.occurrence_id = o.id AND n.user_id = u.id
           AND n.kind = ${kind}::play_session_notification_kind
           -- Reminders are facts about the OCCURRENCE, so they are filed
           -- once with a NULL ticket. Keying them by ticket instead would
           -- re-send "24 hours to go" to anyone who withdrew and re-joined,
           -- whose created_at (and so whose eligibility) never moved.
           AND n.rsvp_seq IS NULL
      )
    ORDER BY o.starts_at, pos.position
    LIMIT ${limit}
  `);
  return result.rows.map(toRecipient);
}

/**
 * Everyone holding an active RSVP for a cancelled occurrence — going AND
 * waitlisted, because somebody who was third in the queue still rearranged
 * their evening around the possibility.
 *
 * Read at send time, from the live table. The cancellation job carries an
 * occurrence id and nothing else, so no address ever sits in a queue row.
 */
export async function cancellationRecipients(
  db: SqlRunner,
  occurrenceId: string,
): Promise<SessionMailRecipient[]> {
  const result = await db.execute(sql`
    SELECT ${recipientColumns()}
    ${recipientJoins()}
    WHERE o.id = ${occurrenceId}::uuid
    ORDER BY pos.position
  `);
  return result.rows.map(toRecipient);
}

/**
 * Every future cancelled occurrence of a series, for the series-cancellation
 * mail. One message per occurrence rather than one summary: a member with an
 * RSVP to two of the six remaining Tuesdays should be told about those two, and
 * the ledger is keyed per occurrence anyway.
 */
export async function seriesCancellationRecipients(
  db: SqlRunner,
  sessionId: string,
): Promise<SessionMailRecipient[]> {
  const result = await db.execute(sql`
    SELECT ${recipientColumns()}
    ${recipientJoins()}
    WHERE o.session_id = ${sessionId}::uuid
      AND o.status = 'cancelled'
      AND o.starts_at > now()
    ORDER BY o.starts_at, pos.position
  `);
  return result.rows.map(toRecipient);
}

/**
 * One named member on one occurrence — the confirmation, waitlist and promotion
 * paths, which know exactly who they are writing to.
 */
export async function recipientsFor(
  db: SqlRunner,
  occurrenceId: string,
  userIds: readonly string[],
): Promise<SessionMailRecipient[]> {
  if (userIds.length === 0) return [];
  // A bare array binds as ($1, $2) which Postgres rejects for = ANY; build the
  // array constructor explicitly (CLAUDE.md).
  const ids = sql`ARRAY[${sql.join(
    userIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`;
  const result = await db.execute(sql`
    SELECT ${recipientColumns()}
    ${recipientJoins()}
    WHERE o.id = ${occurrenceId}::uuid AND u.id = ANY(${ids})
    ORDER BY pos.position
  `);
  return result.rows.map(toRecipient);
}

/**
 * Who is `going` right now. Used either side of a withdrawal to work out who
 * was promoted — Stage 4.1 promotes by arithmetic, with no code running and
 * therefore no event to hook, so the difference of two reads is the only honest
 * way to detect it.
 *
 * Two concurrent withdrawals can both compute an overlapping promotion set.
 * That is deliberate rather than locked away: the notification ledger dedupes
 * the send, so the race costs a wasted query and never a duplicate email.
 */
export async function goingUserIds(db: SqlRunner, occurrenceId: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT user_id FROM play_session_rsvp_positions
     WHERE occurrence_id = ${occurrenceId}::uuid AND rsvp_status = 'going'
     ORDER BY position
  `);
  return result.rows.map((row) => String(row.user_id));
}

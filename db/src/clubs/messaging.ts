import {
  AUTOMATION_CATCH_UP_DAYS,
  type Audience,
  type AudienceFilter,
  type AudienceSegment,
  type AutomationChannel,
  type AutomationTrigger,
  type BroadcastPurpose,
  type ClubTier,
  type IsoDate,
  type MessageChannel,
} from '@sportkarta/lib/clubs';
import { sql, type SQL } from 'drizzle-orm';

import type { ClubMailClub } from './mail.js';

/**
 * What the worker needs to send a club's messages by e-mail, SMS and push
 * (0051). Everything is read at SEND time — a job carries ids only.
 *
 * THE CHANNEL RULES, on top of 0044's recipient rules (mail.ts):
 *   - e-mail: as every club mail — a linked member at their POPS address
 *     unless they muted the club; an unlinked record only if the club mails
 *     unlinked clients and the record never opted out;
 *   - SMS: the receiving record's own phone, unless it opted out of SMS;
 *   - push: a linked member's devices, unless they muted this club's push;
 *   - MARKETING additionally needs the receiving record's consent timestamp
 *     for that channel, and never goes by push (the CHECK on club_broadcasts);
 *   - a minor is never addressed: the guardian's record receives, by the same
 *     rules, or nobody does.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

const CLUB_NAME = sql`CASE WHEN c.locale = 'en' THEN coalesce(c.name_en, c.name_bg) ELSE c.name_bg END`;

/** The Sofia day's first instant. */
const SOFIA_DAY_START = sql`(date_trunc('day', now() AT TIME ZONE 'Europe/Sofia') AT TIME ZONE 'Europe/Sofia')`;

export interface MemberChannels extends ClubMailClub {
  tier: ClubTier;
  /** clubs.sms_notify — the automatic notices this club also sends by SMS. */
  smsNotify: string[];
  /** The record the message is ABOUT (perhaps a child). */
  memberId: string;
  aboutName: string;
  /** The record that RECEIVES it (the guardian for a minor). */
  targetMemberId: string;
  recipientName: string;
  /** Where e-mail goes, or null when the record may not be mailed. */
  email: string | null;
  linked: boolean;
  /** The receiving record's opt-out token (unsubscribe pages, 0040). */
  unsubscribeToken: string;
  marketingEmail: boolean;
  /** The receiving record's phone as typed; null when SMS may not go to it. */
  phone: string | null;
  marketingSms: boolean;
  /** The account whose devices receive push, or null. */
  pushUserId: string | null;
  /** That account has at least one device right now (the preview's count). */
  pushDevices: boolean;
}

function channelsQuery(clubId: string, memberIds: readonly string[]): SQL {
  return sql`
    SELECT m.id AS member_id, m.display_name AS about_name,
           t.id AS target_id, t.display_name AS target_name, t.email AS target_email,
           (t.email_opt_out_at IS NOT NULL) AS opted_out, t.unsubscribe_token,
           t.phone, (t.sms_opt_out_at IS NOT NULL) AS sms_opted_out,
           (t.marketing_email_at IS NOT NULL) AS marketing_email,
           (t.marketing_sms_at IS NOT NULL) AS marketing_sms,
           c.id AS club_id, c.slug, c.locale, c.status, c.tier, c.public_email,
           c.mail_unlinked_members, c.sms_notify, ${CLUB_NAME} AS club_name,
           l.user_id, l.notify_email, l.notify_push,
           u.email AS user_email, u.display_name AS user_name,
           EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = l.user_id) AS has_devices
      FROM club_members m
      JOIN clubs c ON c.id = m.club_id AND c.status = 'active'
      JOIN club_members t ON t.club_id = m.club_id
                         AND t.id = CASE WHEN m.is_minor THEN m.guardian_member_id ELSE m.id END
                         AND NOT t.is_minor AND t.archived_at IS NULL
      LEFT JOIN club_member_links l ON l.club_id = t.club_id AND l.member_id = t.id
                                   AND l.status = 'active'
      LEFT JOIN users u ON u.id = l.user_id
     WHERE m.club_id = ${clubId}::uuid AND m.id = ANY(${sql.param([...memberIds])}::uuid[])`;
}

function toChannels(row: Record<string, unknown>): MemberChannels {
  const linked = row.user_id !== null && row.user_id !== undefined;
  const email = linked
    ? row.notify_email === true
      ? text(row.user_email)
      : null
    : row.mail_unlinked_members === true && row.opted_out !== true
      ? text(row.target_email)
      : null;
  return {
    clubId: String(row.club_id),
    clubSlug: String(row.slug),
    clubName: String(row.club_name),
    locale: row.locale === 'en' ? 'en' : 'bg',
    status: String(row.status),
    replyTo: text(row.public_email),
    tier: String(row.tier) as ClubTier,
    smsNotify: Array.isArray(row.sms_notify) ? row.sms_notify.map(String) : [],
    memberId: String(row.member_id),
    aboutName: String(row.about_name),
    targetMemberId: String(row.target_id),
    recipientName: (linked ? text(row.user_name) : null) || String(row.target_name),
    email,
    linked,
    unsubscribeToken: String(row.unsubscribe_token),
    marketingEmail: row.marketing_email === true,
    phone: row.sms_opted_out === true ? null : text(row.phone),
    marketingSms: row.marketing_sms === true,
    pushUserId: linked && row.notify_push === true ? String(row.user_id) : null,
    pushDevices: linked && row.notify_push === true && row.has_devices === true,
  };
}

/** Resolve who, by which channels, receives a message about one club record. */
export async function memberChannels(
  db: SqlRunner,
  clubId: string,
  memberId: string,
): Promise<MemberChannels | null> {
  const result = await db.execute(channelsQuery(clubId, [memberId]));
  const row = result.rows[0];
  return row ? toChannels(row) : null;
}

/** The same for many records in one statement — the office's reach preview. */
export async function membersChannels(
  db: SqlRunner,
  clubId: string,
  memberIds: readonly string[],
): Promise<MemberChannels[]> {
  if (memberIds.length === 0) return [];
  const result = await db.execute(channelsQuery(clubId, memberIds));
  return result.rows.map(toChannels);
}

/** Whether `purpose` may go to this recipient by `channel` at all. */
export function channelAllowed(
  recipient: Pick<
    MemberChannels,
    'email' | 'phone' | 'pushUserId' | 'marketingEmail' | 'marketingSms'
  >,
  channel: MessageChannel,
  purpose: BroadcastPurpose,
): boolean {
  switch (channel) {
    case 'email':
      return recipient.email !== null && (purpose === 'service' || recipient.marketingEmail);
    case 'sms':
      return recipient.phone !== null && (purpose === 'service' || recipient.marketingSms);
    case 'push':
      return recipient.pushUserId !== null && purpose === 'service';
  }
}

// ─── Push subscriptions ────────────────────────────────────────────────────

export interface StoredPushSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function pushSubscriptionsOf(
  db: SqlRunner,
  userId: string,
): Promise<StoredPushSubscription[]> {
  const result = await db.execute(sql`
    SELECT id, endpoint, p256dh, auth FROM push_subscriptions
     WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 10
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    endpoint: String(row.endpoint),
    p256dh: String(row.p256dh),
    auth: String(row.auth),
  }));
}

/** After this many failures in a row a device is presumed gone. */
const PUSH_FAILURE_LIMIT = 20;

/**
 * The push service's answer about one device: `gone` deletes it (the
 * browser revoked the subscription), `sent` resets its failure count,
 * `failed` counts towards PUSH_FAILURE_LIMIT.
 */
export async function notePushResult(
  db: SqlRunner,
  subscriptionId: string,
  result: 'sent' | 'gone' | 'failed',
): Promise<void> {
  if (result === 'gone') {
    await db.execute(sql`DELETE FROM push_subscriptions WHERE id = ${subscriptionId}::uuid`);
  } else if (result === 'sent') {
    await db.execute(sql`
      UPDATE push_subscriptions SET last_success_at = now(), failure_count = 0
       WHERE id = ${subscriptionId}::uuid
    `);
  } else {
    // Two statements: a data-modifying CTE and the DELETE beside it see the
    // same snapshot, so a combined statement would never delete the row.
    await db.execute(sql`
      UPDATE push_subscriptions SET failure_count = least(failure_count + 1, 100)
       WHERE id = ${subscriptionId}::uuid
    `);
    await db.execute(sql`
      DELETE FROM push_subscriptions
       WHERE id = ${subscriptionId}::uuid AND failure_count >= ${PUSH_FAILURE_LIMIT}
    `);
  }
}

// ─── Broadcasts ───────────────────────────────────────────────────────────

/** A club may write (and so send): the SQL twin of canWrite (policies.ts). */
function writable(today: IsoDate): SQL {
  return sql`c.status = 'active' AND (c.tier = 'community'
    OR greatest(c.paid_until, c.trial_ends_on) + 14 >= ${today}::date)`;
}

/**
 * A message that never started and whose time passed this long ago is no
 * longer news: «closed today» must not go out the week after, when a lapsed
 * club pays again. The sweep cancels it instead (`cancelled_by` stays empty —
 * nobody at the club did).
 */
export const BROADCAST_STALE_DAYS = 3;

export async function cancelStaleBroadcasts(db: SqlRunner): Promise<number> {
  const result = await db.execute(sql`
    UPDATE club_broadcasts SET status = 'cancelled', cancelled_at = now(), updated_at = now()
     WHERE status = 'scheduled'
       AND scheduled_for < now() - make_interval(days => ${BROADCAST_STALE_DAYS}::int)
     RETURNING id
  `);
  return result.rows.length;
}

/**
 * Broadcasts whose time has come, of clubs that may still send them: an
 * active club whose tier still includes broadcasts. A club that lapsed or
 * moved down a tier keeps its scheduled messages, unsent, until that changes
 * or it cancels them (or they go stale).
 */
export async function dueBroadcasts(
  db: SqlRunner,
  tiers: readonly ClubTier[],
  today: IsoDate,
): Promise<
  { id: string; clubId: string; status: 'scheduled' | 'sending'; channels: MessageChannel[] }[]
> {
  if (tiers.length === 0) return [];
  // The club that sent least today goes first, then the oldest message — so
  // one club's big backlog cannot starve everybody else of the allowance.
  const result = await db.execute(sql`
    SELECT b.id, b.club_id, b.status, b.channels,
           (SELECT count(*) FROM club_notifications n
             WHERE n.club_id = b.club_id AND n.kind = 'broadcast' AND n.channel = 'email'
               AND n.sent_at >= ${SOFIA_DAY_START}) AS sent_today
      FROM club_broadcasts b
      JOIN clubs c ON c.id = b.club_id
     WHERE b.status IN ('scheduled', 'sending') AND b.scheduled_for <= now()
       AND c.tier = ANY(${sql.param([...tiers])}::text[]) AND ${writable(today)}
     ORDER BY sent_today, b.scheduled_for, b.id
     LIMIT 50
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    clubId: String(row.club_id),
    status: row.status === 'sending' ? 'sending' : 'scheduled',
    channels: (Array.isArray(row.channels) ? row.channels : []).map(String) as MessageChannel[],
  }));
}

/** Who a broadcast already reached, as `channel:recipientMemberId`. */
export async function broadcastReached(
  db: SqlRunner,
  clubId: string,
  broadcastId: string,
): Promise<Set<string>> {
  const prefix = `broadcast:${broadcastId}:`;
  const result = await db.execute(sql`
    SELECT n.channel, substring(n.dedupe_key from ${prefix.length + 1}) AS member
      FROM club_notifications n
     WHERE n.club_id = ${clubId}::uuid AND n.kind = 'broadcast'
       AND left(n.dedupe_key, ${prefix.length}) = ${prefix}
  `);
  return new Set(result.rows.map((row) => `${String(row.channel)}:${String(row.member)}`));
}

/** Whether a broadcast is still being sent (it may have been cancelled mid-run). */
export async function broadcastStillSending(db: SqlRunner, broadcastId: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT status FROM club_broadcasts WHERE id = ${broadcastId}::uuid
  `);
  return result.rows[0]?.status === 'sending';
}

export interface BroadcastToSend {
  id: string;
  clubId: string;
  purpose: BroadcastPurpose;
  channels: MessageChannel[];
  audience: Audience;
  subject: string;
  body: string;
  smsBody: string | null;
  /** When the first run began — a message still failing a day later closes. */
  startedAt: Date;
}

function audienceOf(row: Record<string, unknown>): Audience {
  switch (row.audience_kind) {
    case 'segment':
      return { kind: 'segment', segment: String(row.audience_value) as AudienceSegment };
    case 'filter':
      return { kind: 'filter', filter: String(row.audience_value) as AudienceFilter };
    case 'tag':
      return { kind: 'tag', tag: String(row.audience_value) };
    case 'plan':
      return { kind: 'plan', planId: String(row.plan_id) };
    case 'class':
      return { kind: 'class', classId: String(row.class_id) };
    default:
      return { kind: 'all' };
  }
}

/**
 * Mark a due broadcast as being sent and return what to send. Idempotent: a
 * broadcast already `sending` (a run that stopped half-way — a worker
 * restart, the daily bulk-mail limit) is picked up again, and the ledger
 * skips everyone it already reached.
 */
export async function startBroadcast(
  db: SqlRunner,
  broadcastId: string,
): Promise<BroadcastToSend | null> {
  const result = await db.execute(sql`
    UPDATE club_broadcasts
       SET status = 'sending', started_at = coalesce(started_at, now()), updated_at = now()
     WHERE id = ${broadcastId}::uuid AND status IN ('scheduled', 'sending')
       AND scheduled_for <= now()
     RETURNING id, club_id, purpose, channels, audience_kind, audience_value, plan_id, class_id,
               subject, body, sms_body, started_at
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    clubId: String(row.club_id),
    purpose: row.purpose === 'marketing' ? 'marketing' : 'service',
    channels: (Array.isArray(row.channels) ? row.channels : []).map(String) as MessageChannel[],
    audience: audienceOf(row),
    subject: String(row.subject),
    body: String(row.body),
    smsBody: text(row.sms_body),
    startedAt: new Date(String(row.started_at)),
  };
}

/** Close a broadcast with its per-channel counts, read from the ledger. */
export async function finishBroadcast(db: SqlRunner, broadcastId: string): Promise<boolean> {
  const result = await db.execute(sql`
    WITH sent AS (
      SELECT n.channel, count(*)::int AS n
        FROM club_notifications n
        JOIN club_broadcasts b ON b.club_id = n.club_id AND b.id = ${broadcastId}::uuid
       WHERE n.kind = 'broadcast' AND n.dedupe_key LIKE 'broadcast:' || b.id::text || ':%'
       GROUP BY n.channel
    )
    UPDATE club_broadcasts
       SET status = 'sent', finished_at = now(), updated_at = now(),
           sent_email = coalesce((SELECT n FROM sent WHERE channel = 'email'), 0),
           sent_sms = coalesce((SELECT n FROM sent WHERE channel = 'sms'), 0),
           sent_push = coalesce((SELECT n FROM sent WHERE channel = 'push'), 0)
     WHERE id = ${broadcastId}::uuid AND status = 'sending'
     RETURNING id
  `);
  return result.rows.length > 0;
}

/**
 * Bulk e-mail sent today (Sofia) across every club — the global daily limit
 * — and how much of it was broadcasts (which may not take all of it).
 */
export async function bulkMailSentToday(
  db: SqlRunner,
): Promise<{ total: number; broadcasts: number }> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS total, (count(*) FILTER (WHERE kind = 'broadcast'))::int AS broadcasts
      FROM club_notifications
     WHERE kind IN ('broadcast', 'automation') AND channel = 'email'
       AND sent_at >= ${SOFIA_DAY_START}
  `);
  return {
    total: Number(result.rows[0]?.total ?? 0),
    broadcasts: Number(result.rows[0]?.broadcasts ?? 0),
  };
}

// ─── Automations ──────────────────────────────────────────────────────────

export interface ActiveAutomation {
  id: string;
  clubId: string;
  trigger: AutomationTrigger;
  channel: AutomationChannel;
  delayDays: number;
  subject: string | null;
  body: string;
}

/** Automation e-mails each club sent today (Sofia) — who goes first in the share. */
export async function automationMailToday(db: SqlRunner): Promise<Map<string, number>> {
  const result = await db.execute(sql`
    SELECT club_id, count(*)::int AS n FROM club_notifications
     WHERE kind = 'automation' AND channel = 'email' AND sent_at >= ${SOFIA_DAY_START}
     GROUP BY club_id
  `);
  return new Map(result.rows.map((row) => [String(row.club_id), Number(row.n)]));
}

/** Every switched-on automation of a club that may send and whose tier has them. */
export async function activeAutomations(
  db: SqlRunner,
  tiers: readonly ClubTier[],
  today: IsoDate,
): Promise<ActiveAutomation[]> {
  if (tiers.length === 0) return [];
  const result = await db.execute(sql`
    SELECT a.id, a.club_id, a.trigger, a.channel, a.delay_days, a.subject, a.body
      FROM club_automations a
      JOIN clubs c ON c.id = a.club_id
     WHERE a.active AND c.tier = ANY(${sql.param([...tiers])}::text[]) AND ${writable(today)}
     ORDER BY a.club_id, a.trigger, a.channel
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    clubId: String(row.club_id),
    trigger: String(row.trigger) as AutomationTrigger,
    channel: row.channel === 'sms' ? 'sms' : 'email',
    delayDays: Number(row.delay_days),
    subject: text(row.subject),
    body: String(row.body),
  }));
}

export interface AutomationCandidate {
  memberId: string;
  /** The event answered: 'first', a membership id, or a last visit's day. */
  anchor: string;
}

/**
 * Who an automation answers today: members whose event happened `delayDays`
 * ago, give or take the catch-up window — so switching an automation on does
 * not reach back to last year, and a day the worker missed is made up.
 *
 *   welcome            the first visit ever at the club (anchor 'first');
 *   trial_follow_up    a trial abonnement ended, and nothing bought since;
 *   expired_follow_up  a paid abonnement ended, and no later one exists;
 *   win_back           the last visit (anchor: its day) — a new visit makes
 *                      a new anchor, so a member can be won back twice.
 *
 * An event this automation's channel already answered is not offered again,
 * so the run's share of the allowance is divided only between clubs with
 * somebody left to answer. Per channel, like the ledger: a club may run the
 * same trigger by e-mail AND by SMS (`club_automations_one_per_trigger` is
 * per channel), and one going must not cancel the other.
 */
export async function automationCandidates(
  db: SqlRunner,
  automation: Pick<ActiveAutomation, 'clubId' | 'trigger' | 'channel' | 'delayDays'>,
  today: IsoDate,
): Promise<AutomationCandidate[]> {
  const club = sql`${automation.clubId}::uuid`;
  const window = (day: SQL) => sql`(${day} + ${automation.delayDays}::int)
      BETWEEN ${today}::date - ${AUTOMATION_CATCH_UP_DAYS}::int AND ${today}::date`;
  const live = sql`EXISTS (SELECT 1 FROM club_members am
                            WHERE am.club_id = ${club} AND am.id = x.member_id AND am.archived_at IS NULL)`;
  let query: SQL;
  switch (automation.trigger) {
    case 'welcome':
      query = sql`
        SELECT x.member_id, 'first' AS anchor FROM (
          SELECT ci.member_id, min(ci.sofia_day) AS first_day
            FROM club_checkins ci WHERE ci.club_id = ${club} GROUP BY ci.member_id
        ) x
         WHERE ${window(sql`x.first_day`)} AND ${live}`;
      break;
    case 'win_back':
      query = sql`
        SELECT x.member_id, to_char(x.last_day, 'YYYY-MM-DD') AS anchor FROM (
          SELECT ci.member_id, max(ci.sofia_day) AS last_day
            FROM club_checkins ci WHERE ci.club_id = ${club} GROUP BY ci.member_id
        ) x
         WHERE ${window(sql`x.last_day`)} AND ${live}`;
      break;
    case 'trial_follow_up':
    case 'expired_follow_up': {
      const trial = automation.trigger === 'trial_follow_up';
      query = sql`
        SELECT x.member_id, x.membership_id::text AS anchor
          FROM club_membership_balances x
         WHERE x.club_id = ${club} AND x.cancelled_at IS NULL
           AND ${trial ? sql`x.kind = 'trial'` : sql`x.kind <> 'trial'`}
           AND x.effective_ends_on < ${today}::date
           AND ${window(sql`x.effective_ends_on`)}
           AND NOT EXISTS (
             SELECT 1 FROM club_membership_balances later
              WHERE later.club_id = x.club_id AND later.member_id = x.member_id
                AND later.membership_id <> x.membership_id AND later.cancelled_at IS NULL
                AND later.kind <> 'trial'
                AND later.effective_ends_on > x.effective_ends_on)
           AND ${live}`;
      break;
    }
  }
  const result = await db.execute(sql`
    SELECT c.member_id, c.anchor FROM (${query}) c
     WHERE NOT EXISTS (
       SELECT 1 FROM club_notifications n
        WHERE n.club_id = ${club} AND n.kind = 'automation'
          AND n.channel = ${automation.channel}
          AND n.dedupe_key = 'automation:' || ${automation.trigger}::text || ':'
                             || c.member_id::text || ':' || c.anchor)
     ORDER BY 1, 2 LIMIT 2000`);
  return result.rows.map((row) => ({
    memberId: String(row.member_id),
    anchor: String(row.anchor),
  }));
}

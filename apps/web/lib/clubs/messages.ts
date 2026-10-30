import {
  broadcastTargets,
  channelAllowed,
  getDb,
  membersChannels,
  sql,
  type SQL,
} from '@sportkarta/db';
import {
  AUTOMATION_CHANNELS,
  AUTOMATION_TRIGGERS,
  BROADCASTS_PER_DAY,
  clubHasFeature,
  composeSms,
  personalise,
  type Audience,
  type AudienceFilter,
  type AudienceSegment,
  type AutomationChannel,
  type AutomationTrigger,
  type BroadcastPurpose,
  type BroadcastStatus,
  type ClubTier,
  type MessageChannel,
  type SmsNotifyKind,
} from '@sportkarta/lib/clubs';
import { SMS_MAX_PARTS, smsParts, toE164 } from '@sportkarta/lib/sms/text';

import { recordClubAudit } from './audit';
import { violatedConstraint } from './errors';
import { clubFeatureSql, clubSwitchOn } from './features';
import type { AutomationInput, BroadcastInput } from './input';
import { clubActorMay, clubScope, clubWriteScope, type ClubActor } from './scope';

/**
 * A club's own messages (0051, wave F): broadcasts to a group, the
 * automations that answer events by themselves, and which automatic notices
 * also go by SMS. Written by `messages.send` (owner, manager) on a tier with
 * the feature; SENT only by the worker (apps/worker/src/club-messages-job.ts),
 * which re-reads the group and every recipient's consents at send time.
 *
 * A message is a draft until it is scheduled; from then on its text is fixed
 * (club_broadcasts_guard) — to change it, cancel it and write a new one. At
 * most BROADCASTS_PER_DAY messages per club per Sofia day leave the draft.
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

// ─── Broadcasts ───────────────────────────────────────────────────────────

export interface ClubBroadcast {
  id: string;
  purpose: BroadcastPurpose;
  channels: MessageChannel[];
  audience: Audience;
  subject: string;
  body: string;
  smsBody: string | null;
  status: BroadcastStatus;
  scheduledFor: string | null;
  createdAt: string;
  finishedAt: string | null;
  sent: { email: number; sms: number; push: number } | null;
  createdByName: string | null;
  /** Cancelled by the sweep, not by anybody at the club: it never got to start. */
  cancelledBySystem: boolean;
}

function audienceFrom(row: Record<string, unknown>): Audience {
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

const BROADCAST_COLUMNS = sql`bc.id, bc.purpose, bc.channels, bc.audience_kind, bc.audience_value,
  bc.plan_id, bc.class_id, bc.subject, bc.body, bc.sms_body, bc.status, bc.scheduled_for,
  bc.created_at, bc.finished_at, bc.sent_email, bc.sent_sms, bc.sent_push,
  (bc.status = 'cancelled' AND bc.cancelled_by IS NULL) AS cancelled_by_system,
  (SELECT u.display_name FROM users u WHERE u.id = bc.created_by) AS created_by_name`;

function toBroadcast(row: Record<string, unknown>): ClubBroadcast {
  return {
    id: String(row.id),
    purpose: row.purpose === 'marketing' ? 'marketing' : 'service',
    channels: (Array.isArray(row.channels) ? row.channels : []).map(String) as MessageChannel[],
    audience: audienceFrom(row),
    subject: String(row.subject),
    body: String(row.body),
    smsBody: text(row.sms_body),
    status: String(row.status) as BroadcastStatus,
    scheduledFor: iso(row.scheduled_for),
    createdAt: iso(row.created_at) ?? '',
    finishedAt: iso(row.finished_at),
    sent:
      row.sent_email === null || row.sent_email === undefined
        ? null
        : {
            email: Number(row.sent_email),
            sms: Number(row.sent_sms ?? 0),
            push: Number(row.sent_push ?? 0),
          },
    createdByName: text(row.created_by_name),
    cancelledBySystem: row.cancelled_by_system === true,
  };
}

export async function listBroadcasts(actor: ClubActor): Promise<ClubBroadcast[]> {
  const result = await getDb().execute(sql`
    SELECT ${BROADCAST_COLUMNS} FROM club_broadcasts bc
     WHERE ${clubScope(actor, 'messages.send', 'bc')}
     ORDER BY coalesce(bc.scheduled_for, bc.created_at) DESC, bc.id
     LIMIT 200
  `);
  return result.rows.map(toBroadcast);
}

export async function broadcastDetail(
  actor: ClubActor,
  broadcastId: string,
): Promise<ClubBroadcast | null> {
  const result = await getDb().execute(sql`
    SELECT ${BROADCAST_COLUMNS} FROM club_broadcasts bc
     WHERE ${clubScope(actor, 'messages.send', 'bc')} AND bc.id = ${broadcastId}::uuid
  `);
  const row = result.rows[0];
  return row ? toBroadcast(row) : null;
}

/** The longest name `{name}` may become in this club's messages. */
export async function longestMemberName(actor: ClubActor): Promise<number> {
  const result = await getDb().execute(sql`
    SELECT coalesce(max(char_length(m.display_name)), 0)::int AS n FROM club_members m
     WHERE ${clubScope(actor, 'messages.send', 'm')} AND m.archived_at IS NULL
  `);
  return Number(result.rows[0]?.n ?? 0);
}

/** The tags on the club's records, for the group picker. */
export async function clubTagsInUse(actor: ClubActor): Promise<string[]> {
  const result = await getDb().execute(sql`
    SELECT DISTINCT tag FROM club_members m, unnest(m.tags) AS tag
     WHERE ${clubScope(actor, 'messages.send', 'm')} AND m.archived_at IS NULL
     ORDER BY tag
     LIMIT 200
  `);
  return result.rows.map((row) => String(row.tag));
}

/** The audience columns of a broadcast row. */
function audienceColumns(audience: Audience): {
  kind: string;
  value: string | null;
  planId: string | null;
  classId: string | null;
} {
  switch (audience.kind) {
    case 'all':
      return { kind: 'all', value: null, planId: null, classId: null };
    case 'segment':
      return { kind: 'segment', value: audience.segment, planId: null, classId: null };
    case 'filter':
      return { kind: 'filter', value: audience.filter, planId: null, classId: null };
    case 'tag':
      return { kind: 'tag', value: audience.tag, planId: null, classId: null };
    case 'plan':
      return { kind: 'plan', value: null, planId: audience.planId, classId: null };
    case 'class':
      return { kind: 'class', value: null, planId: null, classId: audience.classId };
  }
}

/**
 * The channels this club may use right now: e-mail always; SMS where the
 * operator switched it on and the tier has it; push where it is switched on
 * (every tier). Marketing never by push.
 */
export function channelsOn(club: { tier: ClubTier }): MessageChannel[] {
  return [
    'email',
    ...(clubSwitchOn('sms') && clubHasFeature(club.tier, 'sms') ? (['sms'] as const) : []),
    ...(clubSwitchOn('push') ? (['push'] as const) : []),
  ];
}

/**
 * Whether an SMS text still fits SMS_MAX_PARTS once the worker has put the
 * club's name in front, a long member name into `{name}` and — for an offer
 * — the opt-out link at the end. Checked when the club saves it, so a
 * message is refused while the club can still shorten it, never dropped
 * quietly at send time.
 */
export function smsFits(input: {
  clubName: string;
  text: string;
  marketing: boolean;
  optOutLabel: string;
  siteUrl: string;
  /** The club's longest member name, in characters. */
  longestName: number;
}): boolean {
  const longName = 'Ж'.repeat(Math.max(1, input.longestName));
  const composed = composeSms({
    clubName: input.clubName,
    text: personalise(input.text, { name: longName, club: input.clubName }),
    optOut: input.marketing
      ? { label: input.optOutLabel, url: `${input.siteUrl}/s/${'0'.repeat(32)}` }
      : null,
  });
  return smsParts(composed) <= SMS_MAX_PARTS;
}

/** SQL: every channel of the message is one this club's tier may use. */
function channelsAllowedSql(clubId: string, channels: readonly MessageChannel[]): SQL {
  return channels.includes('sms') ? clubFeatureSql(clubId, 'sms') : sql`true`;
}

export type SaveBroadcastResult =
  | { ok: true; broadcastId: string }
  | { ok: false; error: 'not_found' | 'message_audience_invalid' | 'readOnly' };

/** Create a draft (`broadcastId` null) or edit one that is still a draft. */
export async function saveBroadcastDraft(
  db: TransactionalDb,
  actor: ClubActor,
  broadcastId: string | null,
  input: BroadcastInput,
): Promise<SaveBroadcastResult> {
  const audience = audienceColumns(input.audience);
  const channels = sql.param([...input.channels]);
  try {
    return await db.transaction(async (tx) => {
      const saved = broadcastId
        ? await tx.execute(sql`
            UPDATE club_broadcasts bc
               SET purpose = ${input.purpose}, channels = ${channels}::text[],
                   audience_kind = ${audience.kind}, audience_value = ${audience.value},
                   plan_id = ${audience.planId}::uuid, class_id = ${audience.classId}::uuid,
                   subject = ${input.subject}, body = ${input.body}, sms_body = ${input.smsBody},
                   updated_at = now()
             WHERE bc.id = ${broadcastId}::uuid AND bc.status = 'draft'
               AND ${clubWriteScope(actor, 'messages.send', 'bc')}
               AND ${clubFeatureSql(actor.clubId, 'broadcasts')}
               AND ${channelsAllowedSql(actor.clubId, input.channels)}
             RETURNING bc.id
          `)
        : await tx.execute(sql`
            INSERT INTO club_broadcasts (club_id, purpose, channels, audience_kind, audience_value,
                                         plan_id, class_id, subject, body, sms_body, created_by)
            SELECT ${actor.clubId}::uuid, ${input.purpose}, ${channels}::text[], ${audience.kind},
                   ${audience.value}, ${audience.planId}::uuid, ${audience.classId}::uuid,
                   ${input.subject}, ${input.body}, ${input.smsBody}, ${actor.userId}
             WHERE ${clubActorMay(actor, 'messages.send', { write: true })}
               AND ${clubFeatureSql(actor.clubId, 'broadcasts')}
               AND ${channelsAllowedSql(actor.clubId, input.channels)}
            RETURNING id
          `);
      const id = text(saved.rows[0]?.id);
      if (!id) return { ok: false, error: broadcastId ? 'not_found' : 'readOnly' };
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'broadcast_saved',
        detail: { broadcastId: id, purpose: input.purpose, channels: input.channels.length },
      });
      return { ok: true, broadcastId: id };
    });
  } catch (error: unknown) {
    // A plan or class of another club fails the composite key (23503).
    const constraint = violatedConstraint(error);
    if (constraint === 'club_broadcasts_plan_fk' || constraint === 'club_broadcasts_class_fk') {
      return { ok: false, error: 'message_audience_invalid' };
    }
    throw error;
  }
}

/** A draft goes away entirely; nothing was sent, so nothing is kept. */
export async function deleteBroadcastDraft(
  db: TransactionalDb,
  actor: ClubActor,
  broadcastId: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    DELETE FROM club_broadcasts bc
     WHERE bc.id = ${broadcastId}::uuid AND bc.status = 'draft'
       AND ${clubWriteScope(actor, 'messages.send', 'bc')}
     RETURNING bc.id
  `);
  return result.rows.length > 0;
}

export type ScheduleResult =
  { ok: true } | { ok: false; error: 'not_found' | 'broadcast_daily_limit' | 'readOnly' };

/**
 * A draft is scheduled for `at` (now, or later): its text is fixed from here.
 * The daily cap counts messages that left the draft for the same Sofia day,
 * under a per-club lock so two presses cannot both slip in.
 */
export async function scheduleBroadcast(
  db: TransactionalDb,
  actor: ClubActor,
  broadcastId: string,
  at: Date,
): Promise<ScheduleResult> {
  const lockKey = `club_broadcasts:${actor.clubId}`;
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT bc.id FROM club_broadcasts bc
       WHERE bc.id = ${broadcastId}::uuid AND bc.status = 'draft'
         AND ${clubWriteScope(actor, 'messages.send', 'bc')}
       FOR NO KEY UPDATE
    `);
    if (!locked.rows[0]) return { ok: false, error: 'not_found' };
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const day = await tx.execute(sql`
      SELECT count(*)::int AS n FROM club_broadcasts x
       WHERE x.club_id = ${actor.clubId}::uuid AND x.status IN ('scheduled', 'sending', 'sent')
         AND (x.scheduled_for AT TIME ZONE 'Europe/Sofia')::date
             = (${at.toISOString()}::timestamptz AT TIME ZONE 'Europe/Sofia')::date
    `);
    if (Number(day.rows[0]?.n ?? 0) >= BROADCASTS_PER_DAY) {
      return { ok: false, error: 'broadcast_daily_limit' };
    }
    const updated = await tx.execute(sql`
      UPDATE club_broadcasts bc
         SET status = 'scheduled', scheduled_for = ${at.toISOString()}::timestamptz,
             updated_at = now()
       WHERE bc.id = ${broadcastId}::uuid AND bc.status = 'draft'
         AND ${clubWriteScope(actor, 'messages.send', 'bc')}
         AND ${clubFeatureSql(actor.clubId, 'broadcasts')}
       RETURNING bc.id
    `);
    if (updated.rows.length === 0) return { ok: false, error: 'readOnly' };
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'broadcast_scheduled',
      detail: { broadcastId, at: at.toISOString() },
    });
    return { ok: true };
  });
}

/** A scheduled message that has not started goes back to a draft, to be edited. */
export async function unscheduleBroadcast(
  db: TransactionalDb,
  actor: ClubActor,
  broadcastId: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE club_broadcasts bc
       SET status = 'draft', scheduled_for = NULL, updated_at = now()
     WHERE bc.id = ${broadcastId}::uuid AND bc.status = 'scheduled'
       AND bc.scheduled_for > now()
       AND ${clubWriteScope(actor, 'messages.send', 'bc')}
     RETURNING bc.id
  `);
  return result.rows.length > 0;
}

/**
 * A scheduled message is cancelled — kept, so the office sees it was. One
 * already being sent stops for those it has not reached yet (the worker
 * checks between recipients).
 */
export async function cancelBroadcast(
  db: TransactionalDb,
  actor: ClubActor,
  broadcastId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // A message cancelled while being sent keeps the counts of what it reached.
    const sent = (channel: MessageChannel) => sql`(
      SELECT count(*)::int FROM club_notifications n
       WHERE n.club_id = bc.club_id AND n.kind = 'broadcast' AND n.channel = ${channel}
         AND left(n.dedupe_key, char_length('broadcast:' || bc.id::text || ':'))
             = 'broadcast:' || bc.id::text || ':')`;
    const result = await tx.execute(sql`
      UPDATE club_broadcasts bc
         SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${actor.userId},
             updated_at = now(),
             sent_email = CASE WHEN bc.status = 'sending' THEN ${sent('email')} END,
             sent_sms = CASE WHEN bc.status = 'sending' THEN ${sent('sms')} END,
             sent_push = CASE WHEN bc.status = 'sending' THEN ${sent('push')} END
       WHERE bc.id = ${broadcastId}::uuid AND bc.status IN ('scheduled', 'sending')
         AND ${clubWriteScope(actor, 'messages.send', 'bc')}
       RETURNING bc.id
    `);
    if (result.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'broadcast_cancelled',
      detail: { broadcastId },
    });
    return true;
  });
}

export interface BroadcastReach {
  /** Receiving records in the group (a guardian once for several children). */
  recipients: number;
  email: number;
  sms: number;
  push: number;
}

/**
 * How many the message would reach today, by channel — by the worker's own
 * rules (db/src/clubs/messaging.ts channelAllowed). The group is read only
 * after the actor's permission is proved in SQL.
 */
export async function broadcastReach(
  actor: ClubActor,
  broadcast: Pick<ClubBroadcast, 'audience' | 'purpose'>,
  tier: ClubTier,
): Promise<BroadcastReach> {
  const allowed = await getDb().execute(sql`
    SELECT ${clubActorMay(actor, 'messages.send', { write: false })} AS ok
  `);
  if (allowed.rows[0]?.ok !== true) return { recipients: 0, email: 0, sms: 0, push: 0 };
  const targets = await broadcastTargets(getDb(), actor.clubId, broadcast.audience);
  const people = await membersChannels(getDb(), actor.clubId, targets);
  const count = (channel: MessageChannel, extra: (p: (typeof people)[number]) => boolean) =>
    people.filter((p) => channelAllowed(p, channel, broadcast.purpose) && extra(p)).length;
  return {
    recipients: targets.length,
    email: count('email', () => true),
    sms:
      clubSwitchOn('sms') && clubHasFeature(tier, 'sms')
        ? count('sms', (p) => p.phone !== null && toE164(p.phone) !== null)
        : 0,
    push: clubSwitchOn('push') ? count('push', (p) => p.pushDevices) : 0,
  };
}

// ─── Automations ──────────────────────────────────────────────────────────

export interface ClubAutomation {
  trigger: AutomationTrigger;
  channel: AutomationChannel;
  /** Null when this trigger and channel was never set up. */
  id: string | null;
  delayDays: number | null;
  subject: string | null;
  body: string | null;
  active: boolean;
}

/** Every trigger × channel, set up or not, in catalogue order. */
export async function listAutomations(actor: ClubActor): Promise<ClubAutomation[]> {
  const result = await getDb().execute(sql`
    SELECT au.id, au.trigger, au.channel, au.delay_days, au.subject, au.body, au.active
      FROM club_automations au
     WHERE ${clubScope(actor, 'messages.send', 'au')}
  `);
  const byKey = new Map(
    result.rows.map((row) => [`${String(row.trigger)}:${String(row.channel)}`, row]),
  );
  return AUTOMATION_TRIGGERS.flatMap((trigger) =>
    AUTOMATION_CHANNELS.map((channel) => {
      const row = byKey.get(`${trigger}:${channel}`);
      return {
        trigger,
        channel,
        id: row ? String(row.id) : null,
        delayDays: row ? Number(row.delay_days) : null,
        subject: row ? text(row.subject) : null,
        body: row ? text(row.body) : null,
        active: row?.active === true,
      };
    }),
  );
}

export async function saveAutomation(
  db: TransactionalDb,
  actor: ClubActor,
  input: AutomationInput,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const saved = await tx.execute(sql`
      INSERT INTO club_automations (club_id, trigger, channel, delay_days, subject, body, active,
                                    updated_by)
      SELECT ${actor.clubId}::uuid, ${input.trigger}, ${input.channel}, ${input.delayDays},
             ${input.subject}, ${input.body}, ${input.active}, ${actor.userId}
       WHERE ${clubActorMay(actor, 'messages.send', { write: true })}
         AND ${clubFeatureSql(actor.clubId, 'automations')}
         AND ${input.channel === 'sms' ? clubFeatureSql(actor.clubId, 'sms') : sql`true`}
         AND ${input.trigger === 'feedback_request' ? clubFeatureSql(actor.clubId, 'feedback') : sql`true`}
      ON CONFLICT (club_id, trigger, channel) DO UPDATE
        SET delay_days = EXCLUDED.delay_days, subject = EXCLUDED.subject, body = EXCLUDED.body,
            active = EXCLUDED.active, updated_by = EXCLUDED.updated_by, updated_at = now()
      RETURNING id
    `);
    const id = text(saved.rows[0]?.id);
    if (!id) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'automation_saved',
      detail: { trigger: input.trigger, channel: input.channel, active: input.active },
    });
    return true;
  });
}

// ─── SMS settings ─────────────────────────────────────────────────────────

export interface SmsOverview {
  notify: SmsNotifyKind[];
  /** Parts per Sofia month, set by the operator (0 = no SMS). */
  cap: number;
  usedThisMonth: number;
}

export async function smsOverview(actor: ClubActor): Promise<SmsOverview | null> {
  const result = await getDb().execute(sql`
    SELECT c.sms_notify, c.sms_monthly_cap,
           (SELECT coalesce(sum(u.parts), 0)::int FROM club_sms_usage u
             WHERE u.club_id = c.id
               AND u.month = date_trunc('month', now() AT TIME ZONE 'Europe/Sofia')::date) AS used
      FROM clubs c
     WHERE c.id = ${actor.clubId}::uuid
       AND ${clubActorMay(actor, 'settings.manage', { write: false })}
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    notify: (Array.isArray(row.sms_notify) ? row.sms_notify.map(String) : []) as SmsNotifyKind[],
    cap: Number(row.sms_monthly_cap ?? 0),
    usedThisMonth: Number(row.used ?? 0),
  };
}

export async function saveSmsNotify(
  db: TransactionalDb,
  actor: ClubActor,
  kinds: readonly SmsNotifyKind[],
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE clubs SET sms_notify = ${sql.param([...kinds])}::text[], updated_at = now()
       WHERE id = ${actor.clubId}::uuid
         AND ${clubActorMay(actor, 'settings.manage', { write: true })}
         AND ${clubFeatureSql(actor.clubId, 'sms')}
       RETURNING id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'sms_settings_changed',
      detail: { kinds: kinds.length },
    });
    return true;
  });
}

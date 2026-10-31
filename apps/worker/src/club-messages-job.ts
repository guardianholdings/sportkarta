import {
  activeAutomations,
  automationCandidates,
  automationMailToday,
  broadcastReached,
  broadcastStillSending,
  broadcastTargets,
  bulkMailSentToday,
  cancelStaleBroadcasts,
  channelAllowed,
  claimClubNotification,
  dueBroadcasts,
  finishBroadcast,
  getDb,
  membersChannels,
  startBroadcast,
  type ActiveAutomation,
  type AutomationCandidate,
  type BroadcastToSend,
  type MemberChannels,
} from '@sportkarta/db';
import {
  BROADCAST_EMAILS_PER_SWEEP,
  BROADCAST_SHARE_OF_BULK,
  CLUB_TIERS,
  automationPurpose,
  inBroadcastHours,
  clubHasFeature,
  composeSms,
  dedupeKey,
  personalise,
  sofiaToday,
  type BroadcastPurpose,
  type IsoDate,
  type MessageChannel,
} from '@sportkarta/lib/clubs';
import {
  deliverEach,
  emptyDeliveryReport,
  renderClubMail,
  type DeliveryOutcome,
  type DeliveryReport,
} from '@sportkarta/lib/email';

import { sendPushTo, sendSmsTo } from './club-channels.js';
import { clubMailStrings, pick, siteBase, type ClubMailOptions } from './club-mail-job.js';

/**
 * A club's own messages (0051): broadcasts to a group, and the automations
 * that answer events by themselves. ALL SENDING HAPPENS HERE, by the same
 * claim-then-send ledger as every club mail, one claim per (recipient,
 * channel) — so a sweep that stops half-way, a worker restart or a retry
 * reaches exactly the people it had not reached.
 *
 * WHO RECEIVES is decided at the start of each run: the group is re-read
 * (db/src/clubs/audience.ts — the members list's own definitions), and the
 * receiving records' channels and consents are read fresh, in one statement
 * per batch (membersChannels / channelAllowed). A member who opted out after
 * the message was scheduled does not get it.
 *
 * VOLUME: bulk e-mail (broadcasts and automations together) stops at
 * CLUB_BULK_MAIL_DAILY_LIMIT per Sofia day across all clubs — the relay's
 * own daily limit is what a too-big run would trip, and a tripped relay
 * takes the sign-in codes down with it. The allowance is spent only on a
 * message that actually goes (after its claim), never on somebody already
 * reached, and it is SHARED: broadcasts may use BROADCAST_SHARE_OF_BULK of
 * it (the rest is kept for the automations), each club at most
 * BROADCAST_EMAILS_PER_SWEEP per sweep, and the club that sent least today
 * goes first — one club's big backlog cannot starve the others. Messages go
 * out only in BROADCAST_HOURS (never at night); a broadcast the allowance
 * interrupted stays `sending` and carries on in the next sweep or the next
 * day. SMS and push do not wait for the e-mail allowance.
 */

const db = () => getDb();

export interface ClubMessageOptions extends ClubMailOptions {
  /** CLUB_BULK_MAIL_DAILY_LIMIT. */
  bulkMailDailyLimit: number;
  /** BROADCAST_HOURS unless a test widens it. */
  sendingHours?: { from: number; until: number };
  /** BROADCAST_SHARE_OF_BULK unless a test changes it. */
  broadcastShare?: number;
}

/**
 * A message still failing for somebody a day after it began is closed with
 * what it reached: an address the relay will never take must not keep it
 * «sending» — and re-reading its whole group every five minutes — forever.
 * The ledger keeps exactly who received it.
 */
const GIVE_UP_AFTER_MS = 24 * 3600_000;

/** Records whose channels are read in one statement. */
const BATCH = 500;

/** How often a long run checks whether its message was cancelled meanwhile. */
const CANCEL_CHECK_EVERY = 10;

const BROADCAST_TIERS = CLUB_TIERS.filter((tier) => clubHasFeature(tier, 'broadcasts'));
const AUTOMATION_TIERS = CLUB_TIERS.filter((tier) => clubHasFeature(tier, 'automations'));
const FEEDBACK_TIERS = CLUB_TIERS.filter((tier) => clubHasFeature(tier, 'feedback'));

/**
 * Broadcasts whose SMS and push have nobody left to reach (this process's
 * memory — a restart costs one extra read). While the e-mail allowance is
 * empty they are not re-read every five minutes: only their e-mail is left.
 */
const otherChannelsDone = new Set<string>();

/** The way out a marketing message carries, and the one an unlinked record always gets. */
function optOut(
  recipient: MemberChannels,
  purpose: BroadcastPurpose,
  options: ClubMailOptions,
): { pageUrl: string; postUrl: string } | null {
  const base = siteBase(options, recipient.locale);
  const root = options.siteUrl.replace(/\/+$/, '');
  const token = recipient.unsubscribeToken;
  if (purpose === 'marketing') {
    return {
      pageUrl: `${base}/klubove/otpisvane/${token}?vid=marketing`,
      postUrl: `${root}/api/clubs/otpisvane/${token}?vid=marketing`,
    };
  }
  if (!recipient.linked) {
    return {
      pageUrl: `${base}/klubove/otpisvane/${token}`,
      postUrl: `${root}/api/clubs/otpisvane/${token}`,
    };
  }
  return null;
}

/**
 * A run's allowance of bulk e-mail, shared by every message in the run, with
 * an optional cap per club for this run (the per-sweep share).
 */
class MailBudget {
  /** E-mails this run did not send because an allowance was used up. */
  refused = 0;
  private readonly byClub = new Map<string, number>();
  constructor(
    private left: number,
    private readonly perClub = Number.POSITIVE_INFINITY,
  ) {}

  canTake(clubId: string): boolean {
    return this.left > 0 && (this.byClub.get(clubId) ?? 0) < this.perClub;
  }

  take(clubId: string): boolean {
    if (!this.canTake(clubId)) {
      this.refused += 1;
      return false;
    }
    this.left -= 1;
    this.byClub.set(clubId, (this.byClub.get(clubId) ?? 0) + 1);
    return true;
  }

  /** Counted as held without opening a transaction. */
  refuse(): DeliveryOutcome {
    this.refused += 1;
    return 'skipped';
  }

  get remaining(): number {
    return Math.max(0, this.left);
  }
}

/** The allowance refused a claimed e-mail: roll the claim back, try again tomorrow. */
class BudgetHeld extends Error {}

interface OwnMessage {
  kind: 'broadcast' | 'automation';
  purpose: BroadcastPurpose;
  key: string;
  /** club_notifications.member_id. */
  ledgerMemberId: string;
  subject: string;
  body: string;
  /** Where in the portal the button opens (a request to rate: the rating page). */
  portalPath?: string;
}

async function sendOwnEmail(
  recipient: MemberChannels,
  message: OwnMessage,
  options: ClubMailOptions,
  budget: MailBudget,
): Promise<DeliveryOutcome> {
  const email = recipient.email;
  if (!email) return 'skipped';
  try {
    return await db().transaction(async (tx) => {
      const claimed = await claimClubNotification(tx, {
        clubId: recipient.clubId,
        memberId: message.ledgerMemberId,
        kind: message.kind,
        key: message.key,
      });
      if (!claimed) return 'skipped';
      // Only now, for a message that will really go out.
      if (!budget.take(recipient.clubId)) throw new BudgetHeld();
      const strings = clubMailStrings(recipient.locale);
      const way = optOut(recipient, message.purpose, options);
      const base = siteBase(options, recipient.locale);
      const rendered = renderClubMail(
        {
          kind: message.kind,
          clubName: recipient.clubName,
          recipientName: recipient.recipientName,
          values: { subject: message.subject, body: message.body },
          actionUrl: recipient.linked
            ? `${base}/klub/${recipient.clubSlug}/az${message.portalPath ?? ''}`
            : `${base}/klub/${recipient.clubSlug}`,
          replyTo: recipient.replyTo,
          ...(way ? { unsubscribePageUrl: way.pageUrl, unsubscribePostUrl: way.postUrl } : {}),
        },
        message.purpose === 'marketing'
          ? { ...strings, unsubscribe: pick(recipient.locale, 'unsubscribeMarketing') }
          : strings,
      );
      await options.mailer.send({ ...rendered, to: email });
      return 'sent';
    });
  } catch (error: unknown) {
    if (error instanceof BudgetHeld) return 'skipped';
    throw error;
  }
}

function smsText(
  recipient: MemberChannels,
  text: string,
  purpose: BroadcastPurpose,
  options: ClubMailOptions,
): string {
  const root = options.siteUrl.replace(/\/+$/, '');
  return composeSms({
    clubName: recipient.clubName,
    text,
    optOut:
      purpose === 'marketing'
        ? {
            label: pick(recipient.locale, 'smsOptOut'),
            url: `${root}/s/${recipient.unsubscribeToken}`,
          }
        : null,
  });
}

/**
 * What a lock screen may show: the club's text WITHOUT a member's name.
 * `{name}` is dropped, and the punctuation it leaves behind tidied
 * («Здравейте, {name}!» → «Здравейте!»).
 */
function withoutName(template: string, club: string): string {
  return personalise(template, { name: '', club })
    .replace(/\s+([,!.?])/g, '$1')
    .replace(/,([!.?])/g, '$1')
    .replace(/^[\s,!.?]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Every record's channels, read in batches of BATCH. */
async function channelsOf(clubId: string, memberIds: readonly string[]) {
  const out = new Map<string, MemberChannels>();
  for (let i = 0; i < memberIds.length; i += BATCH) {
    const batch = await membersChannels(db(), clubId, memberIds.slice(i, i + BATCH));
    for (const recipient of batch) out.set(recipient.memberId, recipient);
  }
  return out;
}

function addInto(total: DeliveryReport, report: DeliveryReport): void {
  for (const field of ['candidates', 'sent', 'skipped', 'failed', 'unattempted'] as const) {
    total[field] += report[field];
  }
  total.transportDown ||= report.transportDown;
}

// ─── Broadcasts ─────────────────────────────────────────────────────────────

async function sendBroadcast(
  broadcast: BroadcastToSend,
  options: ClubMessageOptions,
  budget: MailBudget,
): Promise<{ report: DeliveryReport; cancelled: boolean; otherFailed: boolean }> {
  const targets = await broadcastTargets(db(), broadcast.clubId, broadcast.audience);
  // Whoever this message already reached is not asked about again.
  const reached = await broadcastReached(db(), broadcast.clubId, broadcast.id);
  const items: { target: string; channel: MessageChannel }[] = targets.flatMap((target) =>
    broadcast.channels
      .filter((channel) => !reached.has(`${channel}:${target}`))
      .map((channel) => ({ target, channel })),
  );
  const recipients = await channelsOf(broadcast.clubId, [
    ...new Set(items.map((item) => item.target)),
  ]);
  let cancelled = false;
  let otherFailed = false;
  let seen = 0;
  const report = await deliverEach(
    items,
    async (item) => {
      try {
        return await sendItem(item);
      } catch (error: unknown) {
        if (item.channel !== 'email') otherFailed = true;
        throw error;
      }
    },
    { job: 'club.broadcasts' },
  );
  return { report, cancelled, otherFailed };

  async function sendItem({
    target,
    channel,
  }: {
    target: string;
    channel: MessageChannel;
  }): Promise<DeliveryOutcome> {
    seen += 1;
    if (seen % CANCEL_CHECK_EVERY === 0 && !cancelled) {
      cancelled = !(await broadcastStillSending(db(), broadcast.id));
    }
    if (cancelled) return 'skipped';
    const recipient = recipients.get(target);
    if (!recipient || !channelAllowed(recipient, channel, broadcast.purpose)) return 'skipped';
    const key = dedupeKey({
      kind: 'broadcast',
      broadcastId: broadcast.id,
      recipientMemberId: recipient.targetMemberId,
    });
    const values = { name: recipient.aboutName, club: recipient.clubName };
    switch (channel) {
      case 'email':
        // Out of allowance: held without opening a transaction.
        if (!budget.canTake(recipient.clubId)) return budget.refuse();
        return sendOwnEmail(
          recipient,
          {
            kind: 'broadcast',
            purpose: broadcast.purpose,
            key,
            ledgerMemberId: recipient.targetMemberId,
            subject: personalise(broadcast.subject, values),
            body: personalise(broadcast.body, values),
          },
          options,
          budget,
        );
      case 'sms':
        return sendSmsTo(
          recipient,
          {
            kind: 'broadcast',
            key,
            ledgerMemberId: recipient.targetMemberId,
            text: smsText(
              recipient,
              personalise(broadcast.smsBody ?? broadcast.subject, values),
              broadcast.purpose,
              options,
            ),
          },
          options.channels,
        );
      case 'push':
        return sendPushTo(
          recipient,
          {
            kind: 'broadcast',
            key,
            ledgerMemberId: recipient.targetMemberId,
            payload: {
              title: recipient.clubName,
              body: withoutName(broadcast.subject, recipient.clubName),
              url: `${recipient.locale === 'en' ? '/en' : ''}/klub/${recipient.clubSlug}/az`,
              tag: `broadcast-${broadcast.id}`,
            },
          },
          options.channels,
        );
    }
  }
}

/**
 * Every five minutes (and on «Изпрати сега»): send the broadcasts whose time
 * has come, inside the sending hours. A broadcast is closed as `sent` only
 * when everybody was reached or skipped (or a day has passed); a failure or
 * the allowance leaves it `sending`, and the next sweep carries on from the
 * ledger. A message cancelled while being sent stops within a few recipients.
 */
export async function runClubBroadcasts(
  options: ClubMessageOptions,
  today: IsoDate = sofiaToday(),
  now: Date = new Date(),
): Promise<{
  broadcasts: number;
  finished: number;
  stale: number;
  held: boolean;
  report: DeliveryReport;
}> {
  const stale = await cancelStaleBroadcasts(db());
  const total = emptyDeliveryReport();
  if (!inBroadcastHours(now, options.sendingHours)) {
    return { broadcasts: 0, finished: 0, stale, held: false, report: total };
  }
  const due = await dueBroadcasts(db(), BROADCAST_TIERS, today);
  const sent = await bulkMailSentToday(db());
  const limit = options.bulkMailDailyLimit;
  const budget = new MailBudget(
    Math.min(
      limit - sent.total,
      Math.floor(limit * (options.broadcastShare ?? BROADCAST_SHARE_OF_BULK)) - sent.broadcasts,
    ),
    BROADCAST_EMAILS_PER_SWEEP,
  );
  let broadcasts = 0;
  let finished = 0;
  let held = false;
  for (const { id, clubId, status, channels } of due) {
    // Already started, only e-mail left and no allowance for this club now:
    // do not re-read the whole group just to hold it again. (A message not
    // yet started always starts, so waiting never makes it stale.)
    const emailOnly = channels.every((c) => c === 'email') || otherChannelsDone.has(id);
    if (status === 'sending' && emailOnly && !budget.canTake(clubId)) {
      held = true;
      continue;
    }
    const broadcast = await startBroadcast(db(), id);
    if (!broadcast) continue;
    broadcasts += 1;
    const refusedBefore = budget.refused;
    const { report, cancelled, otherFailed } = await sendBroadcast(broadcast, options, budget);
    if (!otherFailed && !report.transportDown) otherChannelsDone.add(broadcast.id);
    addInto(total, report);
    const limited = budget.refused > refusedBefore;
    held ||= limited;
    const givenUp = Date.now() - broadcast.startedAt.getTime() > GIVE_UP_AFTER_MS;
    if (!cancelled && !limited && !report.transportDown && (report.failed === 0 || givenUp)) {
      if (await finishBroadcast(db(), broadcast.id)) finished += 1;
    }
    if (report.transportDown) break;
  }
  return { broadcasts, finished, stale, held, report: total };
}

// ─── Automations ────────────────────────────────────────────────────────────

async function runAutomation(
  automation: ActiveAutomation,
  candidates: readonly AutomationCandidate[],
  options: ClubMessageOptions,
  budget: MailBudget,
  /** Collects the candidates the allowance held. */
  held: AutomationCandidate[] = [],
): Promise<DeliveryReport> {
  const purpose = automationPurpose(automation.trigger);
  const recipients = await channelsOf(automation.clubId, [
    ...new Set(candidates.map((candidate) => candidate.memberId)),
  ]);
  return deliverEach(
    candidates,
    async (candidate) => {
      const recipient = recipients.get(candidate.memberId);
      if (!recipient || !channelAllowed(recipient, automation.channel, purpose)) return 'skipped';
      const key = dedupeKey({
        kind: 'automation',
        trigger: automation.trigger,
        memberId: candidate.memberId,
        anchor: candidate.anchor,
      });
      const values = { name: recipient.aboutName, club: recipient.clubName };
      if (automation.channel === 'email') {
        if (!budget.canTake(automation.clubId)) {
          held.push(candidate);
          return budget.refuse();
        }
        return sendOwnEmail(
          recipient,
          {
            kind: 'automation',
            purpose,
            key,
            ledgerMemberId: candidate.memberId,
            subject: personalise(automation.subject ?? '', values),
            body: personalise(automation.body, values),
            ...(automation.trigger === 'feedback_request' ? { portalPath: '/otzivi' } : {}),
          },
          options,
          budget,
        );
      }
      return sendSmsTo(
        recipient,
        {
          kind: 'automation',
          key,
          ledgerMemberId: candidate.memberId,
          text: smsText(recipient, personalise(automation.body, values), purpose, options),
        },
        options.channels,
      );
    },
    { job: 'club.automations' },
  );
}

/**
 * Daily: every club's switched-on automations. The e-mail allowance left for
 * them is SHARED: the first pass gives each club with candidates an equal
 * part, the club that sent fewest today first; a second pass hands what is
 * left to those who still have answers to send. No club, however early its
 * id or busy its welcome, can take every other club's day. Answers missed
 * for the allowance are made up within the catch-up window
 * (AUTOMATION_CATCH_UP_DAYS), the ledger skipping whoever was answered.
 */
export async function runClubAutomations(
  options: ClubMessageOptions,
  today: IsoDate = sofiaToday(),
): Promise<{ automations: number; held: boolean; report: DeliveryReport }> {
  const automations = await activeAutomations(db(), AUTOMATION_TIERS, today, FEEDBACK_TIERS);
  const sentToday = await automationMailToday(db());
  const work: { automation: ActiveAutomation; candidates: AutomationCandidate[] }[] = [];
  for (const automation of automations) {
    const candidates = await automationCandidates(db(), automation, today);
    if (candidates.length > 0) work.push({ automation, candidates });
  }
  work.sort(
    (a, b) => (sentToday.get(a.automation.clubId) ?? 0) - (sentToday.get(b.automation.clubId) ?? 0),
  );
  const clubs = new Set(
    work.filter((w) => w.automation.channel === 'email').map((w) => w.automation.clubId),
  );
  const left = options.bulkMailDailyLimit - (await bulkMailSentToday(db())).total;
  const total = emptyDeliveryReport();
  const first = new MailBudget(left, Math.max(1, Math.ceil(left / Math.max(1, clubs.size))));
  const short: { automation: ActiveAutomation; held: AutomationCandidate[] }[] = [];
  for (const { automation, candidates } of work) {
    const held: AutomationCandidate[] = [];
    const report = await runAutomation(automation, candidates, options, first, held);
    addInto(total, report);
    if (held.length > 0) short.push({ automation, held });
    if (report.transportDown) {
      return { automations: automations.length, held: first.refused > 0, report: total };
    }
  }
  // What the equal parts left over, to the clubs whose answers were held.
  const second = new MailBudget(first.remaining);
  for (const { automation, held } of short) {
    const report = await runAutomation(automation, held, options, second);
    // The first pass counted these as skipped; move them to what happened now.
    total.skipped += report.skipped - report.candidates;
    total.sent += report.sent;
    total.failed += report.failed;
    total.unattempted += report.unattempted;
    if (report.transportDown) {
      total.transportDown = true;
      break;
    }
  }
  return { automations: automations.length, held: second.refused > 0, report: total };
}

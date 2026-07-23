import { readFileSync } from 'node:fs';

import {
  cancellationRecipients,
  claimNotification,
  dueReminders,
  getDb,
  recipientsFor,
  seriesCancellationRecipients,
  type ReminderKind,
  type SessionMailRecipient,
  type SessionNotificationKind,
} from '@sportkarta/db';
import { renderSessionMail, type Mailer, type SessionMailStrings } from '@sportkarta/lib/email';

/**
 * Session mail: confirmations, promotions, reminders and cancellations
 * (docs/ROADMAP.md §6, Stage 4.2).
 *
 * ALL SENDING HAPPENS HERE, in the worker, and nothing sends from a request.
 * The web app enqueues `session.notify` with an occurrence id, a reason and —
 * for the targeted kinds — account ids. It never enqueues an address: a job row
 * outlives the account it names, and an archived queue is a strange place to
 * keep a mailing list. Addresses are read from the live table at send time.
 *
 * IDEMPOTENCY is the ledger's, not this file's. For each recipient, in ONE
 * transaction: claim the (occurrence, member, kind) row first, and send only if
 * the claim inserted. A retried job, an overlapping schedule or a second worker
 * therefore cannot mail anyone twice. The one hole is a crash between the SMTP
 * handoff and COMMIT, which re-sends — the right way round, since
 * send-then-record loses mail silently instead.
 *
 * NO PII IN LOGS: counts and error CATEGORIES only. An SMTP rejection embeds
 * the recipient in its message, so `error.message` is never logged.
 */

const MESSAGES_BY_LOCALE = new Map<string, Record<string, Record<string, string>>>();

/** Same resolution the digest job uses — apps/web/messages is the source of truth. */
function messages(locale: string): Record<string, Record<string, string>> {
  const cached = MESSAGES_BY_LOCALE.get(locale);
  if (cached) return cached;
  const url = new URL(`../../../apps/web/messages/${locale}.json`, import.meta.url);
  const parsed = JSON.parse(readFileSync(url, 'utf8')) as Record<string, Record<string, string>>;
  MESSAGES_BY_LOCALE.set(locale, parsed);
  return parsed;
}

export function sessionMailStrings(locale: string): SessionMailStrings {
  const ns = messages(locale).SessionEmail ?? {};
  // Throw rather than fall back to the key: a renamed message would otherwise
  // ship the literal string "subjectConfirmed" as a Subject line to everybody
  // who signed up today, and the bg↔en parity test cannot see that.
  const pick = (key: string): string => {
    const value = ns[key];
    if (typeof value !== 'string' || value === '') {
      throw new Error(`SessionEmail.${key} is missing from messages/${locale}.json`);
    }
    return value;
  };
  return {
    subjectConfirmed: pick('subjectConfirmed'),
    subjectWaitlisted: pick('subjectWaitlisted'),
    subjectPromoted: pick('subjectPromoted'),
    subjectReminder: pick('subjectReminder'),
    subjectCancelled: pick('subjectCancelled'),
    greeting: pick('greeting'),
    leadConfirmed: pick('leadConfirmed'),
    leadWaitlisted: pick('leadWaitlisted'),
    leadPromoted: pick('leadPromoted'),
    leadReminder: pick('leadReminder'),
    leadCancelled: pick('leadCancelled'),
    labelWhen: pick('labelWhen'),
    labelWhere: pick('labelWhere'),
    labelSpots: pick('labelSpots'),
    spots: pick('spots'),
    spotsUnlimited: pick('spotsUnlimited'),
    viewSession: pick('viewSession'),
    addToCalendar: pick('addToCalendar'),
    withdraw: pick('withdraw'),
    calendarFeed: pick('calendarFeed'),
    footer: pick('footer'),
  };
}

function sportLabels(locale: string): Record<string, string> {
  return messages(locale).Sport ?? {};
}

export interface SessionMailOptions {
  mailer: Mailer;
  /** Absolute site base, e.g. https://sportkarta.bg. */
  siteUrl: string;
  locale?: string;
}

export interface SessionMailReport {
  candidates: number;
  sent: number;
  /** Already told — the ledger refused the claim. */
  skipped: number;
  failed: number;
}

const FAILURE_LOG = 'session mail recipient failed:';

/** A coarse, address-free classification (the digest job's, verbatim in spirit). */
function failureCategory(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code)) return code;
  }
  return 'send_failed';
}

/**
 * Claim, render, send — in one transaction, in that order.
 *
 * The send is inside the transaction deliberately: a throw rolls the claim
 * back, so a failed send is retried on the next run rather than silently
 * swallowed with the ledger insisting it already went.
 */
async function sendOne(
  recipient: SessionMailRecipient,
  kind: SessionNotificationKind,
  strings: SessionMailStrings,
  sports: Record<string, string>,
  options: SessionMailOptions,
): Promise<boolean> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const claimed = await claimNotification(
      tx,
      recipient.occurrenceId,
      recipient.userId,
      kind,
      // Ignored for the occurrence-scoped kinds; required for the RSVP-scoped
      // ones, so re-joining after a withdrawal can be confirmed and promoted
      // again rather than silently swallowed by the ledger.
      recipient.rsvpSeq,
    );
    if (!claimed) return false;

    const base = options.siteUrl.replace(/\/+$/, '');
    const sessionUrl = `${base}/sesiya/${recipient.occurrenceId}`;
    const message = renderSessionMail(
      {
        kind,
        recipientName: recipient.displayName,
        title: recipient.title,
        sport: sports[recipient.sport] ?? recipient.sport,
        startsAtLocal: recipient.startsAtLocal,
        facilityName: recipient.facilityName ?? '',
        facilityUrl: recipient.facilitySlug ? `${base}/obekt/${recipient.facilitySlug}` : undefined,
        sessionUrl,
        calendarUrl: `${base}/kalendar/sesiya/${recipient.occurrenceId}.ics`,
        // Only if they already have a feed. Minting one here would create a
        // credential for somebody who never asked for it.
        feedUrl: recipient.calendarToken
          ? `${base}/kalendar/${recipient.calendarToken}.ics`
          : undefined,
        capacity: recipient.capacity,
        going: recipient.going,
        position: recipient.position,
      },
      strings,
    );

    await options.mailer.send({ ...message, to: recipient.email });
    return true;
  });
}

async function deliver(
  recipients: SessionMailRecipient[],
  kind: SessionNotificationKind,
  options: SessionMailOptions,
): Promise<SessionMailReport> {
  const locale = options.locale ?? 'bg';
  const strings = sessionMailStrings(locale);
  const sports = sportLabels(locale);
  const report: SessionMailReport = {
    candidates: recipients.length,
    sent: 0,
    skipped: 0,
    failed: 0,
  };

  for (const recipient of recipients) {
    try {
      if (await sendOne(recipient, kind, strings, sports, options)) report.sent += 1;
      else report.skipped += 1;
    } catch (error: unknown) {
      report.failed += 1;
      // A CATEGORY, never the message: an SMTP rejection reads
      // "550 5.1.1 <ivan@example.org>: Recipient address rejected", and logging
      // it would write every bounced address into the container log.
      console.error(`[worker] ${FAILURE_LOG} ${failureCategory(error)}`);
    }
  }
  return report;
}

/** Reasons the web app may enqueue. Pinned — job data is arbitrary JSON. */
export const NOTIFY_REASONS = {
  rsvp_confirmed: 'rsvp_confirmed',
  rsvp_waitlisted: 'rsvp_waitlisted',
  promoted: 'promoted',
  occurrence_cancelled: 'occurrence_cancelled',
  series_cancelled: 'series_cancelled',
} as const;

export type NotifyReason = keyof typeof NOTIFY_REASONS;

export interface SessionNotifyJobData {
  reason?: string;
  occurrenceId?: string;
  sessionId?: string;
  /** Account ids — never addresses. Absent means "everyone with an RSVP". */
  userIds?: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

/**
 * Handle one `session.notify` job.
 *
 * Every field of the payload is validated before it reaches a query: job data
 * is arbitrary JSON from whoever enqueued it, and this handler runs with full
 * database access.
 */
export async function runSessionNotify(
  data: SessionNotifyJobData,
  options: SessionMailOptions,
): Promise<SessionMailReport> {
  const db = getDb();
  const reason = data.reason;
  if (!reason || !(reason in NOTIFY_REASONS)) {
    return { candidates: 0, sent: 0, skipped: 0, failed: 0 };
  }

  if (reason === 'series_cancelled') {
    const sessionId = uuidOrNull(data.sessionId);
    if (!sessionId) return { candidates: 0, sent: 0, skipped: 0, failed: 0 };
    const recipients = await seriesCancellationRecipients(db, sessionId);
    return deliver(recipients, 'occurrence_cancelled', options);
  }

  const occurrenceId = uuidOrNull(data.occurrenceId);
  if (!occurrenceId) return { candidates: 0, sent: 0, skipped: 0, failed: 0 };

  if (reason === 'occurrence_cancelled') {
    const recipients = await cancellationRecipients(db, occurrenceId);
    return deliver(recipients, 'occurrence_cancelled', options);
  }

  // The targeted kinds. `userIds` is capped: an unbounded list from a job
  // payload would build an unbounded array constructor.
  const userIds = (Array.isArray(data.userIds) ? data.userIds : [])
    .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64)
    .slice(0, 500);
  const recipients = await recipientsFor(db, occurrenceId, userIds);
  return deliver(recipients, reason as SessionNotificationKind, options);
}

/**
 * The scheduled reminder sweep. Both lead times in one pass, 24 h first: a
 * member who is due both (the job was down all day) should read them in the
 * order they were meant to arrive.
 */
export async function runSessionReminders(
  options: SessionMailOptions,
): Promise<Record<ReminderKind, SessionMailReport>> {
  const db = getDb();
  const kinds: ReminderKind[] = ['reminder_24h', 'reminder_2h'];
  const out = {} as Record<ReminderKind, SessionMailReport>;
  for (const kind of kinds) {
    out[kind] = await deliver(await dueReminders(db, kind), kind, options);
  }
  return out;
}

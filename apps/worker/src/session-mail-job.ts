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
import {
  deliverEach,
  emptyDeliveryReport,
  renderSessionMail,
  type DeliveryOutcome,
  type DeliveryReport,
  type Mailer,
  type SessionMailStrings,
} from '@sportkarta/lib/email';

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
 *
 * RETRIES. A failed send rolls its claim back, and the per-recipient loop
 * (`deliverEach`, lib/src/email/delivery.ts) stops at the first sign that the
 * relay itself is down. What happens next depends on the job: the reminder
 * sweep IS its own retry (it re-reads "not yet told" every ten minutes), but a
 * `session.notify` job is enqueued exactly once — a cancellation, a promotion —
 * so its handler throws on any failure and pg-boss runs it again with backoff.
 * The ledger makes that re-run mail only the people who were not reached.
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
    greetingNoName: pick('greetingNoName'),
    leadConfirmed: pick('leadConfirmed'),
    leadWaitlisted: pick('leadWaitlisted'),
    leadPromoted: pick('leadPromoted'),
    leadReminder: pick('leadReminder'),
    leadCancelled: pick('leadCancelled'),
    labelWhen: pick('labelWhen'),
    labelWhere: pick('labelWhere'),
    labelSpots: pick('labelSpots'),
    spots: pick('spots'),
    spotsUnlimitedOne: pick('spotsUnlimitedOne'),
    spotsUnlimitedOther: pick('spotsUnlimitedOther'),
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
  /** Absolute site base, e.g. https://pops.bg. */
  siteUrl: string;
  locale?: string;
}

/**
 * Counts per run. `skipped` is "already told" (the ledger refused the claim) or
 * "no longer true" (see `stillApplies`); `unattempted` is who the run never
 * reached because the transport went down first.
 */
export type SessionMailReport = DeliveryReport;

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
): Promise<DeliveryOutcome> {
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
    if (!claimed) return 'skipped';

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
        // Only for members who already have a feed, and only a link to the
        // profile where it is managed. The feed URL itself is a credential: a
        // forwarded confirmation would hand the recipient a permanent view of
        // where this member plays.
        calendarSettingsUrl: recipient.hasCalendarFeed ? `${base}/profil` : undefined,
        capacity: recipient.capacity,
        going: recipient.going,
        // The place ON THE WAITLIST, not the queue position (see the recipient
        // type) — the same number the session page shows.
        waitlistPlace: recipient.waitlistPlace ?? undefined,
      },
      strings,
    );

    await options.mailer.send({ ...message, to: recipient.email });
    return 'sent';
  });
}

/**
 * Whether a status-bearing notice is still TRUE when the job runs. A job can
 * run minutes after it was enqueued — and, now that failed runs are retried
 * with backoff, up to an hour later — by which time a waitlisted member may
 * have been promoted. Telling them "you are number 2 on the waitlist" after
 * they are already going is worse than silence; the promotion mail is the one
 * that is true. Skipped rather than claimed, so nothing is recorded as told.
 */
function stillApplies(kind: SessionNotificationKind, recipient: SessionMailRecipient): boolean {
  switch (kind) {
    case 'rsvp_waitlisted':
      return recipient.rsvpStatus === 'waitlisted' && recipient.waitlistPlace !== null;
    case 'rsvp_confirmed':
    case 'promoted':
      return recipient.rsvpStatus === 'going';
    default:
      return true;
  }
}

async function deliver(
  recipients: SessionMailRecipient[],
  kind: SessionNotificationKind,
  options: SessionMailOptions & { job: string },
): Promise<SessionMailReport> {
  // No member locale is stored anywhere yet (users has no locale column), so
  // worker mail is Bulgarian — the default locale — until one is.
  const locale = options.locale ?? 'bg';
  const strings = sessionMailStrings(locale);
  const sports = sportLabels(locale);
  // Counting, categorising (never the message — an SMTP rejection quotes the
  // address) and stopping on a down transport all live in deliverEach.
  return deliverEach(
    recipients,
    async (recipient) =>
      stillApplies(kind, recipient)
        ? sendOne(recipient, kind, strings, sports, options)
        : 'skipped',
    { job: options.job },
  );
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
  const job = { ...options, job: 'session.notify' };
  if (!reason || !(reason in NOTIFY_REASONS)) return emptyDeliveryReport();

  if (reason === 'series_cancelled') {
    const sessionId = uuidOrNull(data.sessionId);
    if (!sessionId) return emptyDeliveryReport();
    const recipients = await seriesCancellationRecipients(db, sessionId);
    return deliver(recipients, 'occurrence_cancelled', job);
  }

  const occurrenceId = uuidOrNull(data.occurrenceId);
  if (!occurrenceId) return emptyDeliveryReport();

  if (reason === 'occurrence_cancelled') {
    const recipients = await cancellationRecipients(db, occurrenceId);
    return deliver(recipients, 'occurrence_cancelled', job);
  }

  // The targeted kinds. `userIds` is capped: an unbounded list from a job
  // payload would build an unbounded array constructor.
  const userIds = (Array.isArray(data.userIds) ? data.userIds : [])
    .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64)
    .slice(0, 500);
  const recipients = await recipientsFor(db, occurrenceId, userIds);
  return deliver(recipients, reason as SessionNotificationKind, job);
}

/**
 * The scheduled reminder sweep. Both lead times in one pass, 24 h first: a
 * member who is due both (the job was down all day) should read them in the
 * order they were meant to arrive.
 */
export async function runSessionReminders(
  options: SessionMailOptions,
): Promise<Partial<Record<ReminderKind, SessionMailReport>>> {
  const db = getDb();
  const kinds: ReminderKind[] = ['reminder_24h', 'reminder_2h'];
  const out: Partial<Record<ReminderKind, SessionMailReport>> = {};
  for (const kind of kinds) {
    const report = await deliver(await dueReminders(db, kind), kind, {
      ...options,
      job: 'session.reminders',
    });
    out[kind] = report;
    // The relay is refusing us: do not open the 2 h batch against the same
    // wall. This sweep does not throw — its next tick, ten minutes on, is the
    // retry, and everyone not reached is still "not yet told".
    if (report.transportDown) break;
  }
  return out;
}

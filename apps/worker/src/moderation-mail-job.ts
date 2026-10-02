import { readFileSync } from 'node:fs';

import {
  claimModerationNotification,
  decisionMailTarget,
  getDb,
  noticeMailTarget,
  type ModerationNotificationSubject,
} from '@sportkarta/db';
import {
  renderModerationMail,
  type Mailer,
  type ModerationMailData,
  type ModerationMailStrings,
} from '@sportkarta/lib/email';
import { groundOf, type ReasonContext } from '@sportkarta/lib/moderation';

/**
 * Moderation mail (migration 0033): the statement of reasons to a member whose
 * photo we refused or took down, or whose facility we removed (DSA Art. 17), and the receipt and the outcome
 * to whoever sent a notice through /signal (Art. 16(4)-(5)).
 *
 * SENT ONLY FROM HERE, like every other mail but the sign-in code. The web app
 * enqueues `moderation.notify` with a decision id or a notice id and nothing
 * else — never an address — and this job resolves the inbox from the live
 * tables at send time (db/src/moderation-mail.ts). An account erased, or a
 * notifier contact swept by retention, between the decision and the send
 * resolves to nobody.
 *
 * IDEMPOTENCY is `moderation_notifications`': claim first, send second, in one
 * transaction, so a retried job cannot mail anybody twice and a failed send
 * rolls its claim back to be retried.
 *
 * NOTHING A NOTIFIER WROTE GOES OUT: a notice mail goes to an address nobody
 * verified, so it names the notice by its date and category and never echoes
 * the reported URL (db/src/moderation-mail.ts does not even read it).
 *
 * NO PII IN LOGS: the caller logs the kind and a count, never an address, a URL
 * or a reason — a notice URL is user input.
 */

type Messages = Record<string, Record<string, string>>;
const MESSAGES_BY_LOCALE = new Map<string, Messages>();

/** Same resolution the session and digest jobs use — apps/web/messages is the source. */
function messages(locale: string): Messages {
  const cached = MESSAGES_BY_LOCALE.get(locale);
  if (cached) return cached;
  const url = new URL(`../../../apps/web/messages/${locale}.json`, import.meta.url);
  const parsed = JSON.parse(readFileSync(url, 'utf8')) as Messages;
  MESSAGES_BY_LOCALE.set(locale, parsed);
  return parsed;
}

const STRING_KEYS = [
  'subjectPhotoRejected',
  'subjectPhotoRemoved',
  'subjectFacilityRemoved',
  'subjectNoticeReceived',
  'subjectNoticeDecided',
  'greeting',
  'leadPhotoRejected',
  'leadPhotoRemoved',
  'leadFacilityRemoved',
  'leadNoticeReceived',
  'leadNoticeActioned',
  'leadNoticeDismissed',
  'noticeNextSteps',
  'noticeNotYours',
  'labelReason',
  'labelDecidedOn',
  'groundLaw',
  'groundTerms',
  'humanDecision',
  'contestEmail',
  'contestForm',
  'courts',
  'terms',
  'unnamedFacility',
  'footer',
] as const satisfies readonly (keyof ModerationMailStrings)[];

export function moderationMailStrings(locale: string): ModerationMailStrings {
  const ns = messages(locale).ModerationEmail ?? {};
  // Throw rather than fall back to the key, as sessionMailStrings does: a
  // renamed message must not ship "subjectPhotoRejected" as a Subject line.
  const out = {} as Record<(typeof STRING_KEYS)[number], string>;
  for (const key of STRING_KEYS) {
    const value = ns[key];
    if (typeof value !== 'string' || value === '') {
      throw new Error(`ModerationEmail.${key} is missing from messages/${locale}.json`);
    }
    out[key] = value;
  }
  return out;
}

/** The reason label, or the slug itself for a reason the catalogue has retired. */
function reasonLabel(locale: string, reason: string | null): string | undefined {
  if (!reason) return undefined;
  return messages(locale).ModerationReason?.[reason] ?? reason;
}

/** The form's own label for a notice category (`Notice.category`), or the slug. */
function noticeCategoryLabel(locale: string, category: string): string {
  const labels = (messages(locale).Notice as Record<string, unknown> | undefined)?.category;
  const label = (labels as Record<string, unknown> | undefined)?.[category];
  return typeof label === 'string' && label !== '' ? label : category;
}

export interface ModerationMailOptions {
  mailer: Mailer;
  /** Absolute site base, e.g. https://pops.bg. */
  siteUrl: string;
  /** CONTACT_EMAIL — where to contest; absent until the operator publishes one. */
  contactEmail?: string | undefined;
  locale?: string;
}

export const MODERATION_NOTIFY_KINDS = {
  decision: 'decision',
  notice_received: 'notice_received',
  notice_decided: 'notice_decided',
} as const;

export interface ModerationNotifyJobData {
  kind?: string;
  decisionId?: number;
  noticeId?: string;
}

export type ModerationNotifyOutcome = 'sent' | 'already_sent' | 'nobody' | 'invalid';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Job data is arbitrary JSON: pin it to one of three shapes before any query. */
export function parseModerationNotify(
  data: ModerationNotifyJobData,
): ModerationNotificationSubject | null {
  if (data.kind === 'decision') {
    const id = data.decisionId;
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0
      ? { kind: 'decision', decisionId: id }
      : null;
  }
  if (data.kind === 'notice_received' || data.kind === 'notice_decided') {
    const id = data.noticeId;
    return typeof id === 'string' && UUID_RE.test(id) ? { kind: data.kind, noticeId: id } : null;
  }
  return null;
}

/** Build the message for one subject, or null when there is nobody to tell. */
async function compose(
  subject: ModerationNotificationSubject,
  options: ModerationMailOptions,
): Promise<{ to: string; data: ModerationMailData } | null> {
  const db = getDb();
  const locale = options.locale ?? 'bg';
  const base = options.siteUrl.replace(/\/+$/, '');
  const common = {
    termsUrl: `${base}/usloviya`,
    noticeFormUrl: `${base}/signal`,
    contactEmail: options.contactEmail?.trim() || null,
  };

  if (subject.kind === 'decision') {
    const target = await decisionMailTarget(db, subject.decisionId);
    if (!target) return null;
    // A takedown is explained from the photo vocabulary, like a rejection.
    const context: ReasonContext =
      target.kind === 'facility_removed' ? 'facility_gone' : 'photo_rejected';
    return {
      to: target.email,
      data: {
        ...common,
        kind: target.kind,
        facilityName: target.facilityName,
        facilityUrl: target.facilitySlug ? `${base}/obekt/${target.facilitySlug}` : undefined,
        reasonLabel: reasonLabel(locale, target.reason),
        ground: target.reason ? groundOf(context, target.reason) : 'terms',
        date: target.decidedOn,
      },
    };
  }

  const target = await noticeMailTarget(db, subject.noticeId);
  if (!target) return null;
  const notice = {
    receivedOn: target.receivedOn,
    categoryLabel: noticeCategoryLabel(locale, target.category),
  };
  if (subject.kind === 'notice_received') {
    return { to: target.email, data: { ...common, kind: 'notice_received', notice } };
  }
  // An outcome for a notice nobody has decided yet is a job enqueued too early
  // or replayed: say nothing rather than announce a decision that does not exist.
  if (target.status === 'pending' || !target.reason) return null;
  const context: ReasonContext =
    target.status === 'actioned' ? 'notice_actioned' : 'notice_dismissed';
  return {
    to: target.email,
    data: {
      ...common,
      kind: target.status === 'actioned' ? 'notice_actioned' : 'notice_dismissed',
      notice,
      reasonLabel: reasonLabel(locale, target.reason),
      ground: groundOf(context, target.reason),
      date: target.decidedOn ?? undefined,
    },
  };
}

/**
 * Handle one `moderation.notify` job. Claim, render, send — in one transaction,
 * in that order; a throw from the relay rolls the claim back so the next run
 * retries instead of the ledger insisting the mail went.
 */
export async function runModerationNotify(
  data: ModerationNotifyJobData,
  options: ModerationMailOptions,
): Promise<ModerationNotifyOutcome> {
  const subject = parseModerationNotify(data);
  if (!subject) return 'invalid';

  const composed = await compose(subject, options);
  if (!composed) return 'nobody';

  const strings = moderationMailStrings(options.locale ?? 'bg');
  return getDb().transaction(async (tx) => {
    if (!(await claimModerationNotification(tx, subject))) return 'already_sent';
    const message = renderModerationMail(composed.data, strings);
    await options.mailer.send({ ...message, to: composed.to });
    return 'sent';
  });
}

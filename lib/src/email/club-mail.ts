/**
 * Club mail (docs/ROADMAP.md Stage 9). Pure, like session-mail.ts: data and
 * already-translated strings in, `MailMessage` out; the worker decides who
 * receives it and when.
 *
 * ONE RENDERER FOR EVERY KIND. A club mail is a greeting, one lead sentence,
 * an optional when/where block, optional detail lines (a trainer's classes,
 * an owner's week — COUNTS, never another member's name), one link and a
 * footer. The subject carries the club's name so the inbox says who it is
 * from even though the sender is POPS.
 *
 * WHAT IS NEVER IN THESE MESSAGES: another member's name or contact; the
 * recipient's address in the subject; a credential other than the one an
 * invitation exists to carry.
 *
 * UNLINKED RECIPIENTS (a club client without a POPS account) get an opt-out
 * line in the body and RFC 8058 List-Unsubscribe headers — the header points
 * at the one-click POST route, the body at the page a person can open.
 */

import { brandEmailHtml } from './html.js';
import type { MailMessage } from './mailer.js';
import { formatLocal } from './session-mail.js';

export const CLUB_MAIL_KINDS = [
  'staff_invite',
  'member_invite',
  'booking_confirmed',
  'booking_promoted',
  'booking_cancelled',
  'class_cancelled',
  'reminder_24h',
  'membership_expiring',
  'membership_expired',
  'application_received',
  'application_approved',
  'operator_new_application',
  'claim_pending',
  'erasure_requested',
  'roster_daily',
  'owner_weekly',
  'membership_renewed',
  'fee_charged',
  'owner_monthly',
  'payment_received',
  'broadcast',
  'automation',
] as const;
export type ClubMailKind = (typeof CLUB_MAIL_KINDS)[number];

export interface ClubMailStrings {
  locale: string;
  /** Per kind; placeholders such as `{club}` `{title}` `{name}` `{date}`. */
  subject: Record<ClubMailKind, string>;
  lead: Record<ClubMailKind, string>;
  /** The label of the one link, per kind. */
  action: Record<ClubMailKind, string>;
  /** `{name}` */
  greeting: string;
  greetingNoName: string;
  labelWhen: string;
  labelWhere: string;
  /** `{club}` — why this person receives club mail. */
  footer: string;
  /** Unlinked recipients: the opt-out line's label. */
  unsubscribe: string;
}

export interface ClubMailData {
  kind: ClubMailKind;
  clubName: string;
  recipientName: string;
  /** Values for the subject and lead placeholders (`club` is filled in). */
  values?: Record<string, string | number>;
  /** Sofia wall clock `YYYY-MM-DDTHH:MM:SS`. */
  startsAtLocal?: string | undefined;
  where?: string | undefined;
  /** Extra lines — counts only. */
  details?: string[] | undefined;
  actionUrl: string;
  /** Unlinked recipients: the page a person opens to opt out. */
  unsubscribePageUrl?: string | undefined;
  /** Unlinked recipients: the RFC 8058 one-click POST target. */
  unsubscribePostUrl?: string | undefined;
  /** The club's own address; only a well-formed single-line address is used. */
  replyTo?: string | null | undefined;
}

export function fillClubTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

const EMAIL = /^[^@\s<>"]{1,64}@[^@\s<>"]{1,190}$/;

/**
 * The club's own words (0051): a broadcast or an automation is the club's
 * whole letter, salutation included, so ours is not added on top of it.
 */
const OWN_TEXT: readonly ClubMailKind[] = ['broadcast', 'automation'];

export function renderClubMail(data: ClubMailData, strings: ClubMailStrings): MailMessage {
  const values = { ...(data.values ?? {}), club: data.clubName };
  const name = data.recipientName.trim();
  const lines: string[] = [
    ...(OWN_TEXT.includes(data.kind)
      ? []
      : [name === '' ? strings.greetingNoName : fillClubTemplate(strings.greeting, { name }), '']),
    fillClubTemplate(strings.lead[data.kind], values),
  ];
  if (data.startsAtLocal || data.where) {
    lines.push('');
    if (data.startsAtLocal) {
      lines.push(`${strings.labelWhen}: ${formatLocal(data.startsAtLocal, strings.locale)}`);
    }
    if (data.where) lines.push(`${strings.labelWhere}: ${data.where}`);
  }
  if (data.details && data.details.length > 0) lines.push('', ...data.details);
  lines.push('', `${strings.action[data.kind]}: ${data.actionUrl}`);
  lines.push('', fillClubTemplate(strings.footer, { club: data.clubName }));
  if (data.unsubscribePageUrl) lines.push(`${strings.unsubscribe}: ${data.unsubscribePageUrl}`);

  const headers: Record<string, string> = {};
  if (data.unsubscribePostUrl) {
    headers['List-Unsubscribe'] = `<${data.unsubscribePostUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  if (data.replyTo && EMAIL.test(data.replyTo)) headers['Reply-To'] = data.replyTo;

  const text = lines.join('\n');
  const subject = `${data.clubName} · ${fillClubTemplate(strings.subject[data.kind], values)}`;
  return {
    to: '',
    // A club name is the club's own text: strip anything that could fold a
    // header line, whatever the column CHECKs already promise.
    subject: subject.replace(/[\r\n]+/g, ' '),
    text,
    html: brandEmailHtml(text, strings.locale),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

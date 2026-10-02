/**
 * Moderation mail: the statement of reasons to a member whose content we
 * restricted (DSA Art. 17), and the receipt and outcome to somebody who sent us
 * a notice (Art. 16(4)-(5)). Migration 0033.
 *
 * Pure, like session-mail.ts next door: data and already-translated strings in,
 * `MailMessage` out. The strings come from `apps/web/messages/<locale>.json`
 * (`ModerationEmail`, `ModerationReason`), so the mail and the admin screen say
 * the same words and the i18n parity test covers both.
 *
 * WHAT A STATEMENT OF REASONS MUST SAY, and therefore what every refusal here
 * carries — Art. 17(3) in the order a reader needs it:
 *   - what we did, and to which content (the facility is named);
 *   - on what ground: the terms of use, or that the content appeared illegal;
 *   - that a person decided it, with no automated decision-making;
 *   - how to contest it: our contact address (or the notice form when none is
 *     published yet) and, always, the courts.
 *
 * WHAT IS NEVER IN THESE MESSAGES:
 *   - Anything a notifier wrote: not the URL they reported, not their
 *     explanation. A notice's reply address is whatever was typed into an
 *     anonymous form, with no proof it is the sender's, so echoing the
 *     notifier's words would let anybody have POPS mail anybody a branded
 *     message carrying a link of their choosing — and no defanging survives
 *     every mail client's autolinker. A notice is identified by what is ours:
 *     the day it arrived and its category from the closed list.
 *   - Who reported the content, or that anybody did. A statement of reasons
 *     that names the notifier turns a notice into a target.
 *   - The moderator. Decisions are the organisation's; the log keeps the name.
 *   - The recipient's name or address. A greeting needs neither, and this way
 *     the mail can be rendered from what the notice row itself holds.
 */

import { brandEmailHtml } from './html.js';
import type { MailMessage } from './mailer.js';

export type ModerationMailKind =
  | 'photo_rejected'
  | 'photo_removed'
  | 'facility_removed'
  | 'notice_received'
  | 'notice_actioned'
  | 'notice_dismissed';

export interface ModerationMailStrings {
  subjectPhotoRejected: string;
  subjectPhotoRemoved: string;
  subjectFacilityRemoved: string;
  subjectNoticeReceived: string;
  subjectNoticeDecided: string;
  greeting: string;
  /** `{facility}` */
  leadPhotoRejected: string;
  /** `{facility}` — a published photo taken down again (0032). */
  leadPhotoRemoved: string;
  /** `{facility}` */
  leadFacilityRemoved: string;
  /** `{date}` `{category}` — the notice's own, never what it reported. */
  leadNoticeReceived: string;
  /** `{date}` `{category}` */
  leadNoticeActioned: string;
  /** `{date}` `{category}` */
  leadNoticeDismissed: string;
  noticeNextSteps: string;
  /** For whoever receives a receipt without having sent anything. */
  noticeNotYours: string;
  labelReason: string;
  /** `{date}` */
  labelDecidedOn: string;
  groundLaw: string;
  groundTerms: string;
  humanDecision: string;
  /** `{email}` */
  contestEmail: string;
  /** `{url}` */
  contestForm: string;
  courts: string;
  /** `{url}` */
  terms: string;
  unnamedFacility: string;
  footer: string;
}

export interface ModerationMailData {
  kind: ModerationMailKind;
  /** The facility the content belonged to, for the three refusal kinds. */
  facilityName?: string | null | undefined;
  /** Link to the facility when it is still public (a rejected photo's). */
  facilityUrl?: string | undefined;
  /**
   * The notice being answered, for the notice kinds: the day it arrived and
   * its already-translated category. Deliberately no field for the reported
   * URL — see "never in these messages" above.
   */
  notice?: { receivedOn: string; categoryLabel: string } | undefined;
  /** Already-translated reason label. Absent on a receipt. */
  reasonLabel?: string | undefined;
  ground?: 'law' | 'terms' | undefined;
  /** Date of the decision, `DD.MM.YYYY`, civil Sofia — formatted by the caller's SQL. */
  date?: string | undefined;
  termsUrl: string;
  /** The published contact address; when absent the notice form is offered. */
  contactEmail?: string | null | undefined;
  noticeFormUrl: string;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

function subjectFor(kind: ModerationMailKind, s: ModerationMailStrings): string {
  switch (kind) {
    case 'photo_rejected':
      return s.subjectPhotoRejected;
    case 'photo_removed':
      return s.subjectPhotoRemoved;
    case 'facility_removed':
      return s.subjectFacilityRemoved;
    case 'notice_received':
      return s.subjectNoticeReceived;
    case 'notice_actioned':
    case 'notice_dismissed':
      return s.subjectNoticeDecided;
  }
}

function leadFor(data: ModerationMailData, s: ModerationMailStrings): string {
  const facility = data.facilityName?.trim() || s.unnamedFacility;
  const notice = {
    date: data.notice?.receivedOn ?? '',
    category: data.notice?.categoryLabel ?? '',
  };
  switch (data.kind) {
    case 'photo_rejected':
      return fill(s.leadPhotoRejected, { facility });
    case 'photo_removed':
      return fill(s.leadPhotoRemoved, { facility });
    case 'facility_removed':
      return fill(s.leadFacilityRemoved, { facility });
    case 'notice_received':
      return fill(s.leadNoticeReceived, notice);
    case 'notice_actioned':
      return fill(s.leadNoticeActioned, notice);
    case 'notice_dismissed':
      return fill(s.leadNoticeDismissed, notice);
  }
}

export function renderModerationMail(
  data: ModerationMailData,
  strings: ModerationMailStrings,
): MailMessage {
  const lines: string[] = [strings.greeting, '', leadFor(data, strings)];
  if (data.facilityUrl) lines.push(`  ${data.facilityUrl}`);

  if (data.kind === 'notice_received') {
    lines.push('', strings.noticeNextSteps, '', strings.noticeNotYours);
  } else {
    if (data.reasonLabel) lines.push('', `${strings.labelReason}: ${data.reasonLabel}`);
    if (data.date) lines.push(fill(strings.labelDecidedOn, { date: data.date }));
    // The ground is what the decision stands on, so it is stated even when the
    // outcome was "no action" — the notifier learns why nothing was removed.
    lines.push(data.ground === 'law' ? strings.groundLaw : strings.groundTerms);
    lines.push(strings.humanDecision);
  }

  // The way to contest travels with every message — a receipt too, because a
  // notifier who got it wrong should be able to correct it before we decide.
  const contact = data.contactEmail?.trim();
  lines.push(
    '',
    contact
      ? fill(strings.contestEmail, { email: contact })
      : fill(strings.contestForm, { url: data.noticeFormUrl }),
  );
  if (data.kind !== 'notice_received') lines.push(strings.courts);
  lines.push(fill(strings.terms, { url: data.termsUrl }), '', strings.footer);

  const text = lines.join('\n');
  return {
    to: '',
    subject: subjectFor(data.kind, strings),
    text,
    html: brandEmailHtml(text),
  };
}

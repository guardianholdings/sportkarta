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
  /** `{url}` `{date}` */
  leadNoticeReceived: string;
  /** `{url}` */
  leadNoticeActioned: string;
  /** `{url}` */
  leadNoticeDismissed: string;
  noticeNextSteps: string;
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
  /** What a notice reported, for the notice kinds. Echoed back, never linked. */
  targetUrl?: string | undefined;
  /** Already-translated reason label. Absent on a receipt. */
  reasonLabel?: string | undefined;
  ground?: 'law' | 'terms' | undefined;
  /** `DD.MM.YYYY`, civil Sofia date — formatted by the caller's SQL. */
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

/**
 * A URL echoed inside a sentence, defanged so no mail client turns it into a
 * link. It came from an anonymous form: whatever it points at, the mail that
 * confirms we received it must not become a way to deliver it.
 */
function inert(url: string): string {
  return url.replace(/^(https?):\/\//i, '$1[:]//');
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
  const url = inert(data.targetUrl ?? '');
  switch (data.kind) {
    case 'photo_rejected':
      return fill(s.leadPhotoRejected, { facility });
    case 'photo_removed':
      return fill(s.leadPhotoRemoved, { facility });
    case 'facility_removed':
      return fill(s.leadFacilityRemoved, { facility });
    case 'notice_received':
      return fill(s.leadNoticeReceived, { url, date: data.date ?? '' });
    case 'notice_actioned':
      return fill(s.leadNoticeActioned, { url });
    case 'notice_dismissed':
      return fill(s.leadNoticeDismissed, { url });
  }
}

export function renderModerationMail(
  data: ModerationMailData,
  strings: ModerationMailStrings,
): MailMessage {
  const lines: string[] = [strings.greeting, '', leadFor(data, strings)];
  if (data.facilityUrl) lines.push(`  ${data.facilityUrl}`);

  if (data.kind === 'notice_received') {
    lines.push('', strings.noticeNextSteps);
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

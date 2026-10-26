import type { ClubNotificationKind } from './vocab.js';

/**
 * A club's own messages (wave F, 0051): what a broadcast and an automation
 * may be, as closed lists that are ALSO CHECK constraints (clubs.test.ts holds
 * them equal), and the few rules that decide who may receive one. Pure and
 * client-safe.
 *
 * SERVICE OR MARKETING is the line everything else hangs on. A service
 * message is about something the member already has — the hall is closed,
 * the class moved — and goes to everyone the club may write to. A marketing
 * message offers something, and goes only to a record that consented to
 * offers on THAT channel (club_members.marketing_email_at / marketing_sms_at,
 * 0045), never by push, and always with a way out. An automation's purpose is
 * fixed by its trigger, not chosen: a "we miss you" is marketing whatever the
 * club calls it.
 */

export const BROADCAST_PURPOSES = ['service', 'marketing'] as const;
export type BroadcastPurpose = (typeof BROADCAST_PURPOSES)[number];

export const BROADCAST_STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'cancelled'] as const;
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

export const AUDIENCE_KINDS = ['all', 'segment', 'filter', 'tag', 'plan', 'class'] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

/** The derived segments of the members list (apps/web/lib/clubs/members.ts). */
export const AUDIENCE_SEGMENTS = ['top', 'regular', 'new', 'trial', 'owes', 'at_risk'] as const;
export type AudienceSegment = (typeof AUDIENCE_SEGMENTS)[number];

/** The members list's filter chips (GET params, so the screen works without JS). */
export const CLUB_MEMBER_FILTERS = [
  'all',
  'with_membership',
  'unpaid',
  'overdue',
  'partial',
  'expiring',
  'leads',
  'lapsed',
  'archived',
] as const;
export type ClubMemberFilter = (typeof CLUB_MEMBER_FILTERS)[number];

/** Days without a visit after which a paying member counts as at risk. */
export const CLUB_AT_RISK_DAYS = 21;

/** The members-list filters a message may go to (not `all`, `partial`, `archived`). */
export const AUDIENCE_FILTERS = [
  'with_membership',
  'unpaid',
  'overdue',
  'expiring',
  'leads',
  'lapsed',
] as const;
export type AudienceFilter = (typeof AUDIENCE_FILTERS)[number];

export type Audience =
  | { kind: 'all' }
  | { kind: 'segment'; segment: AudienceSegment }
  | { kind: 'filter'; filter: AudienceFilter }
  | { kind: 'tag'; tag: string }
  | { kind: 'plan'; planId: string }
  | { kind: 'class'; classId: string };

export type MessageChannel = 'email' | 'sms' | 'push';

export const AUTOMATION_TRIGGERS = [
  'welcome',
  'trial_follow_up',
  'expired_follow_up',
  'win_back',
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const AUTOMATION_CHANNELS = ['email', 'sms'] as const;
export type AutomationChannel = (typeof AUTOMATION_CHANNELS)[number];

/** A welcome is service; everything that asks the member to buy again is marketing. */
export function automationPurpose(trigger: AutomationTrigger): BroadcastPurpose {
  return trigger === 'welcome' ? 'service' : 'marketing';
}

/** The smallest delay each trigger allows, in days (0051's CHECK for win_back). */
export function automationMinDelay(trigger: AutomationTrigger): number {
  return trigger === 'win_back' ? 14 : 0;
}

/** A sensible starting delay when a club first switches a trigger on. */
export function automationDefaultDelay(trigger: AutomationTrigger): number {
  switch (trigger) {
    case 'welcome':
      return 0;
    case 'trial_follow_up':
      return 1;
    case 'expired_follow_up':
      return 3;
    case 'win_back':
      return 21;
  }
}

/**
 * How many days late an automation may still catch up. Switching one on does
 * not message everyone whose event happened last year: only events whose
 * delay ended within this window are answered.
 */
export const AUTOMATION_CATCH_UP_DAYS = 3;

/** clubs.sms_notify (0051): the automatic notices a club may also send by SMS. */
export const SMS_NOTIFY_KINDS = ['reminder_24h', 'class_cancelled', 'booking_promoted'] as const;
export type SmsNotifyKind = (typeof SMS_NOTIFY_KINDS)[number];

/**
 * The automatic notices that also go by push to a member who installed the
 * app: the ones that are about time — a freed place, a cancelled class, a
 * class tomorrow, an abonnement about to end.
 */
export const PUSH_NOTIFY_KINDS: readonly ClubNotificationKind[] = [
  'booking_promoted',
  'class_cancelled',
  'reminder_24h',
  'membership_expiring',
];

export const BROADCAST_SUBJECT_MAX = 150;
export const BROADCAST_BODY_MAX = 4000;
export const SMS_BODY_MAX = 320;

/** At most this many messages per club per Sofia day leave the draft. */
export const BROADCASTS_PER_DAY = 3;

/**
 * When messages to a group go out, in Sofia hours (from inclusive, until
 * exclusive): never at night. One scheduled or resumed outside waits for the
 * morning.
 */
export const BROADCAST_HOURS = { from: 8, until: 21 } as const;

/**
 * Fairness of the shared daily e-mail allowance: per club, per five-minute
 * sweep, at most this many e-mails — so clubs sending at the same time share
 * the allowance instead of the oldest backlog taking it all.
 */
export const BROADCAST_EMAILS_PER_SWEEP = 25;

/**
 * The share of the daily bulk e-mail allowance broadcasts may use; the rest
 * is kept for the automations (welcomes, follow-ups), which run at 10:15.
 */
export const BROADCAST_SHARE_OF_BULK = 0.75;

/** The Sofia hour of an instant (0–23). */
export function sofiaHour(at: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Sofia',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(at),
  );
}

export function inBroadcastHours(
  at: Date,
  hours: { from: number; until: number } = BROADCAST_HOURS,
): boolean {
  const hour = sofiaHour(at);
  return hour >= hours.from && hour < hours.until;
}

/**
 * The text of a club SMS: the club's name first (the sender ID is «POPS», so
 * the name is how the phone says who wrote), the message, and — marketing
 * only — the opt-out link, which the law asks every such message to carry.
 */
export function composeSms(input: {
  clubName: string;
  text: string;
  optOut?: { label: string; url: string } | null;
}): string {
  const head = `${input.clubName.trim()}: ${input.text.trim()}`;
  return input.optOut ? `${head}\n${input.optOut.label} ${input.optOut.url}` : head;
}

/**
 * `{name}` and `{club}` in a club's own text — the only placeholders a
 * broadcast or an automation may use; anything else in braces stays as typed.
 */
export function personalise(template: string, values: { name: string; club: string }): string {
  return template.replace(/\{(name|club)\}/g, (_match, key: 'name' | 'club') => values[key]);
}

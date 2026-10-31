import { readFileSync } from 'node:fs';

import {
  bookingsForMail,
  cancelledOccurrenceBookings,
  chargeClubBookingFees,
  claimClubNotification,
  clubForMail,
  clubLifecycleCandidates,
  clubMonthFigures,
  clubWeekFigures,
  dueClubReminders,
  eventPlacesForMail,
  expiryCandidates,
  feeMailCandidates,
  getDb,
  inboxNoticeOf,
  inviteForMail,
  leadsDue,
  memberChannels,
  memberForStaffMail,
  memberRecipient,
  operatorRecipients,
  receiptCandidates,
  recordClubMonthlyActivity,
  renewalMailCandidates,
  renewClubMemberships,
  setInviteTokenHash,
  staffRecipients,
  trainerClassesOn,
  type ClubBookingMail,
  type ClubEventPlaceMail,
  type ClubMailClub,
  type ClubMemberRecipient,
  type StaffRecipient,
} from '@sportkarta/db';
import {
  addDaysIso,
  CLUB_CONTRACT_MONTHS,
  CLUB_GRACE_DAYS,
  CLUB_ROLES,
  composeSms,
  dedupeKey,
  formatEuro,
  isoWeekKey,
  isoWeekMonday,
  monthStart,
  parseClubNotifyJob,
  PUSH_NOTIFY_KINDS,
  rolesWith,
  SMS_NOTIFY_KINDS,
  sofiaToday,
  type ClubNotifyJob,
  type ClubRole,
} from '@sportkarta/lib/clubs';
import { generateInviteToken, sha256Hex } from '@sportkarta/lib/clubs/secrets';
import {
  CLUB_MAIL_KINDS,
  deliverEach,
  emptyDeliveryReport,
  fillClubTemplate,
  renderClubMail,
  type ClubMailData,
  type ClubMailKind,
  type ClubMailStrings,
  type DeliveryOutcome,
  type DeliveryReport,
  type Mailer,
} from '@sportkarta/lib/email';

import { sendPushTo, sendSmsTo, shortWhen, type ClubChannelOptions } from './club-channels.js';

/**
 * Club mail (docs/ROADMAP.md Stage 9): invitations, booking notices,
 * reminders, abonnement expiry, applications, the desk's to-dos and the
 * staff digests. ALL SENDING HAPPENS HERE; the web app enqueues ids only.
 *
 * Every send is CLAIM-THEN-SEND in one transaction against
 * club_notifications (UNIQUE (club_id, dedupe_key), keys from one builder),
 * so a retry or an overlapping sweep mails nobody twice, and a failed send
 * rolls its claim back to be tried again. The recipient rules — linked
 * members at their POPS address, unlinked records only on the club's
 * instruction and never after an opt-out, minors never, through the
 * guardian — live in @sportkarta/db's `memberRecipient`.
 *
 * INVITATION TOKENS ARE MINTED HERE, at send time: the web app stores a
 * placeholder digest, the job writes the digest of a fresh token in the same
 * transaction as the send, and the token itself exists only in the message.
 * A job row never holds a credential.
 *
 * NO PII IN LOGS: the caller logs counts; deliverEach logs error categories.
 */

type Messages = Record<string, unknown>;
const MESSAGES_BY_LOCALE = new Map<string, Messages>();

function messages(locale: string): Messages {
  const cached = MESSAGES_BY_LOCALE.get(locale);
  if (cached) return cached;
  const url = new URL(`../../../apps/web/messages/${locale}.json`, import.meta.url);
  const parsed = JSON.parse(readFileSync(url, 'utf8')) as Messages;
  MESSAGES_BY_LOCALE.set(locale, parsed);
  return parsed;
}

/** A nested message, or a throw: a missing key must not ship as a subject. */
export function pick(locale: string, path: string): string {
  let node: unknown = messages(locale).ClubEmail;
  for (const part of path.split('.')) {
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
  }
  if (typeof node !== 'string' || node === '') {
    throw new Error(`ClubEmail.${path} is missing from messages/${locale}.json`);
  }
  return node;
}

function perKind(locale: string, group: string): Record<ClubMailKind, string> {
  return Object.fromEntries(
    CLUB_MAIL_KINDS.map((kind) => [kind, pick(locale, `${group}.${kind}`)]),
  ) as Record<ClubMailKind, string>;
}

export function clubMailStrings(locale: string): ClubMailStrings {
  return {
    locale,
    subject: perKind(locale, 'subject'),
    lead: perKind(locale, 'lead'),
    action: perKind(locale, 'action'),
    greeting: pick(locale, 'greeting'),
    greetingNoName: pick(locale, 'greetingNoName'),
    labelWhen: pick(locale, 'labelWhen'),
    labelWhere: pick(locale, 'labelWhere'),
    footer: pick(locale, 'footer'),
    unsubscribe: pick(locale, 'unsubscribe'),
  };
}

/** «12 октомври 2026 г.» / "12 October 2026" for a civil date. */
export function formatCivilDate(date: string, locale: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'bg', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

export interface ClubMailOptions {
  mailer: Mailer;
  /** Absolute site base, e.g. https://pops.bg. */
  siteUrl: string;
  /** SMS and push (0051); absent, a notice goes by e-mail only. */
  channels?: ClubChannelOptions;
  /** Where a club writes to the association (CONTACT_EMAIL) — in the standing mails. */
  contactEmail?: string;
}

export function siteBase(options: ClubMailOptions, locale: string): string {
  return `${options.siteUrl.replace(/\/+$/, '')}${locale === 'en' ? '/en' : ''}`;
}

const db = () => getDb();

// ─── Member mail ────────────────────────────────────────────────────────────

interface MemberMail {
  kind: ClubMailKind;
  clubId: string;
  memberId: string;
  key: string;
  values?: Record<string, string | number>;
  startsAtLocal?: string;
  where?: string;
  /** Where in the portal the link opens (0052: a thread); the portal's front page by default. */
  portalPath?: string;
  /**
   * Lines under the lead, each a ClubEmail path and its values, filled in the
   * RECIPIENT's language (0053: what an event place now is).
   */
  detailLines?: { key: string; values: Record<string, string | number> }[];
  /** The push text's ClubEmail path, when not `push.<kind>` (0053: an offer to pay). */
  pushKey?: string;
}

/**
 * A notice to a member, by every channel it goes by: e-mail as always, then —
 * each in its own claim (club-channels.ts) — push for the notices about time
 * (PUSH_NOTIFY_KINDS) and SMS for the ones the club switched on
 * (clubs.sms_notify). A failed e-mail stops here and is retried whole. A
 * failed SMS or push makes a `club.notify` job retry, and the retry sends only
 * that channel (the e-mail is in the ledger); the SWEEPS (reminders, expiry)
 * pick a notice only while it has no ledger row at all, so there an SMS or a
 * push that failed after its e-mail went is not tried again — the e-mail
 * carried the news.
 */
async function sendToMember(mail: MemberMail, options: ClubMailOptions): Promise<DeliveryOutcome> {
  const email = await sendEmailToMember(mail, options);
  const other = options.channels ? await sendOtherChannels(mail, options) : 'skipped';
  return email === 'sent' || other === 'sent' ? 'sent' : 'skipped';
}

async function sendOtherChannels(
  mail: MemberMail,
  options: ClubMailOptions,
): Promise<DeliveryOutcome> {
  const channels = options.channels;
  const push = channels?.push.on === true && PUSH_NOTIFY_KINDS.includes(mail.kind);
  const sms =
    channels?.sms.on === true && (SMS_NOTIFY_KINDS as readonly string[]).includes(mail.kind);
  if (!push && !sms) return 'skipped';
  const recipient = await memberChannels(db(), mail.clubId, mail.memberId);
  if (!recipient) return 'skipped';
  const values = {
    name: recipient.aboutName,
    ...(mail.values ?? {}),
    when: shortWhen(mail.startsAtLocal),
    where: mail.where ?? '',
  };
  const outcomes: DeliveryOutcome[] = [];
  if (push) {
    outcomes.push(
      await sendPushTo(
        recipient,
        {
          kind: mail.kind,
          key: mail.key,
          ledgerMemberId: mail.memberId,
          payload: {
            title: recipient.clubName,
            body: fillClubTemplate(
              pick(recipient.locale, mail.pushKey ?? `push.${mail.kind}`),
              values,
            ),
            url: `${recipient.locale === 'en' ? '/en' : ''}/klub/${recipient.clubSlug}/az${mail.portalPath ?? ''}`,
            tag: mail.key.slice(0, 64),
          },
        },
        channels,
      ),
    );
  }
  if (sms && recipient.smsNotify.includes(mail.kind)) {
    outcomes.push(
      await sendSmsTo(
        recipient,
        {
          kind: mail.kind,
          key: mail.key,
          ledgerMemberId: mail.memberId,
          text: composeSms({
            clubName: recipient.clubName,
            text: fillClubTemplate(pick(recipient.locale, `sms.${mail.kind}`), values),
          }),
        },
        channels,
      ),
    );
  }
  return outcomes.includes('sent') ? 'sent' : 'skipped';
}

/**
 * Resolve, claim, render, send — one transaction. The link a linked member
 * gets is their portal; an unlinked one has no account to sign in with, so
 * theirs is the club's public page.
 */
async function sendEmailToMember(
  mail: MemberMail,
  options: ClubMailOptions,
): Promise<DeliveryOutcome> {
  return db().transaction(async (tx) => {
    const recipient = await memberRecipient(tx, mail.clubId, mail.memberId);
    if (!recipient) return 'skipped';
    const claimed = await claimClubNotification(tx, {
      clubId: mail.clubId,
      memberId: mail.memberId,
      kind: mail.kind,
      key: mail.key,
    });
    if (!claimed) return 'skipped';
    await options.mailer.send(memberMessage(recipient, mail, options));
    return 'sent';
  });
}

function memberMessage(recipient: ClubMemberRecipient, mail: MemberMail, options: ClubMailOptions) {
  const base = siteBase(options, recipient.locale);
  const root = options.siteUrl.replace(/\/+$/, '');
  const data: ClubMailData = {
    kind: mail.kind,
    clubName: recipient.clubName,
    recipientName: recipient.recipientName,
    values: { name: recipient.aboutName, ...(mail.values ?? {}) },
    startsAtLocal: mail.startsAtLocal,
    where: mail.where,
    details: mail.detailLines?.map((line) =>
      fillClubTemplate(pick(recipient.locale, line.key), line.values),
    ),
    actionUrl: recipient.linked
      ? `${base}/klub/${recipient.clubSlug}/az${mail.portalPath ?? ''}`
      : `${base}/klub/${recipient.clubSlug}`,
    replyTo: recipient.replyTo,
    ...(recipient.unsubscribeToken
      ? {
          unsubscribePageUrl: `${base}/klubove/otpisvane/${recipient.unsubscribeToken}`,
          unsubscribePostUrl: `${root}/api/clubs/otpisvane/${recipient.unsubscribeToken}`,
        }
      : {}),
  };
  return { ...renderClubMail(data, clubMailStrings(recipient.locale)), to: recipient.email };
}

function bookingMail(
  kind: 'booking_confirmed' | 'booking_promoted' | 'booking_cancelled',
  booking: ClubBookingMail,
): MemberMail {
  return {
    kind,
    clubId: booking.clubId,
    memberId: booking.memberId,
    key: dedupeKey({
      kind,
      occurrenceId: booking.occurrenceId,
      memberId: booking.memberId,
      seq: booking.seq,
    }),
    values: { title: booking.title },
    startsAtLocal: booking.startsAtLocal,
    where: booking.locationName,
  };
}

/**
 * Whether a booking notice is still TRUE when the job runs — a confirmation
 * for a booking cancelled a minute later is worse than silence.
 */
function stillApplies(kind: ClubMailKind, booking: ClubBookingMail): boolean {
  switch (kind) {
    case 'booking_confirmed':
    case 'booking_promoted':
    case 'reminder_24h':
      return booking.status === 'going' && !booking.occurrenceCancelled;
    case 'booking_cancelled':
      return booking.status === null;
    default:
      return true;
  }
}

async function deliverBookings(
  kind: 'booking_confirmed' | 'booking_promoted' | 'booking_cancelled',
  bookingIds: string[],
  options: ClubMailOptions,
): Promise<DeliveryReport> {
  const bookings = await bookingsForMail(db(), bookingIds);
  return deliverEach(
    bookings,
    async (booking) =>
      stillApplies(kind, booking) ? sendToMember(bookingMail(kind, booking), options) : 'skipped',
    { job: 'club.notify' },
  );
}

/**
 * An event place's notice (0053), sent only while it is still true: a
 * registration while the place is alive, a promotion while it holds a seat,
 * a cancellation for a place the club's cancelled event took with it.
 */
function eventPlaceApplies(
  kind: 'event_registered' | 'event_promoted' | 'event_cancelled',
  place: ClubEventPlaceMail,
): boolean {
  switch (kind) {
    // A held place is news only while its hold runs — an offer whose time is
    // up (not yet swept) is not sent with a deadline in the past.
    case 'event_registered':
      return (
        place.eventStatus === 'published' &&
        (['confirmed', 'waitlisted'].includes(place.state) ||
          (place.state === 'held' && place.holdLive))
      );
    case 'event_promoted':
      return (
        place.eventStatus === 'published' &&
        (place.state === 'confirmed' || (place.state === 'held' && place.holdLive))
      );
    case 'event_cancelled':
      return place.state === 'cancelled' && place.cancelKind === 'club';
  }
}

/** What the place is now, in a line: a seat, a seat to pay for by then, or a place in line. */
function eventPlaceLine(
  kind: 'event_registered' | 'event_promoted' | 'event_cancelled',
  place: ClubEventPlaceMail,
): { key: string; values: Record<string, string | number> }[] {
  if (kind === 'event_cancelled') return [{ key: 'event.refund', values: {} }];
  if (place.state === 'held') {
    return [
      {
        key: kind === 'event_promoted' ? 'event.offered' : 'event.held',
        values: { until: shortWhen(place.holdEndsLocal ?? undefined) },
      },
    ];
  }
  if (place.state === 'waitlisted') {
    return [{ key: 'event.waitlisted', values: { position: place.position ?? 1 } }];
  }
  return [{ key: 'event.confirmed', values: {} }];
}

async function deliverEventPlaces(
  kind: 'event_registered' | 'event_promoted' | 'event_cancelled',
  registrationIds: string[],
  options: ClubMailOptions,
): Promise<DeliveryReport> {
  const places = await eventPlacesForMail(db(), registrationIds);
  return deliverEach(
    places,
    async (place) =>
      eventPlaceApplies(kind, place)
        ? sendToMember(
            {
              kind,
              clubId: place.clubId,
              memberId: place.memberId,
              key: dedupeKey({ kind, registrationId: place.registrationId }),
              values: {
                title: place.title,
                ticket: place.ticketName,
                until: shortWhen(place.holdEndsLocal ?? undefined),
              },
              startsAtLocal: place.startsAtLocal,
              where: place.locationName,
              detailLines: eventPlaceLine(kind, place),
              ...(kind === 'event_promoted' && place.state === 'held'
                ? { pushKey: 'push.event_offered' }
                : {}),
            },
            options,
          )
        : 'skipped',
    { job: 'club.notify' },
  );
}

// ─── Staff and operator mail ────────────────────────────────────────────────

interface StaffMail {
  kind: ClubMailKind;
  club: ClubMailClub;
  recipient: StaffRecipient;
  key: string;
  /** The ledger's recipient column; null skips the ledger (see staff invites). */
  ledgerUserId: string | null;
  actionUrl: string;
  values?: Record<string, string | number>;
  details?: string[];
  /** Mail in the club's language, or this one (operator mail is Bulgarian). */
  locale?: 'bg' | 'en';
}

async function sendToStaff(mail: StaffMail, options: ClubMailOptions): Promise<DeliveryOutcome> {
  return db().transaction(async (tx) => {
    if (mail.ledgerUserId) {
      const claimed = await claimClubNotification(tx, {
        clubId: mail.club.clubId,
        userId: mail.ledgerUserId,
        kind: mail.kind,
        key: mail.key,
      });
      if (!claimed) return 'skipped';
    }
    const locale = mail.locale ?? mail.club.locale;
    const message = renderClubMail(
      {
        kind: mail.kind,
        clubName: mail.club.clubName,
        recipientName: mail.recipient.name,
        values: mail.values,
        details: mail.details,
        actionUrl: mail.actionUrl,
      },
      clubMailStrings(locale),
    );
    await options.mailer.send({ ...message, to: mail.recipient.email });
    return 'sent';
  });
}

/**
 * An invitation: lock it, mint a token, store its digest, mail the token —
 * one transaction. A staff invitation is addressed to a person who may have
 * no account yet, so its ledger row names the INVITER (the only account in
 * the story); an invitation whose inviter has since left is sent unledgered.
 */
async function sendInvite(
  kind: 'staff_invite' | 'member_invite',
  inviteId: string,
  options: ClubMailOptions,
): Promise<DeliveryOutcome> {
  const table = kind === 'staff_invite' ? 'club_staff_invites' : 'club_member_invites';
  return db().transaction(async (tx) => {
    const invite = await inviteForMail(tx, table, inviteId);
    if (!invite) return 'skipped';
    const club = await clubForMail(tx, invite.clubId);
    if (!club) return 'skipped';
    const key = dedupeKey({ kind, inviteId });
    const ledger =
      kind === 'member_invite'
        ? { memberId: invite.memberId }
        : invite.createdBy
          ? { userId: invite.createdBy }
          : null;
    if (ledger) {
      const claimed = await claimClubNotification(tx, {
        clubId: club.clubId,
        ...ledger,
        kind,
        key,
      });
      if (!claimed) return 'skipped';
    }
    const token = generateInviteToken();
    await setInviteTokenHash(tx, table, invite.inviteId, sha256Hex(token));
    const strings = clubMailStrings(club.locale);
    const roleName =
      invite.role && (CLUB_ROLES as readonly string[]).includes(invite.role)
        ? pick(club.locale, `roleName.${invite.role}`)
        : '';
    const message = renderClubMail(
      {
        kind,
        clubName: club.clubName,
        recipientName: invite.memberName ?? '',
        values: { role: roleName, name: invite.memberName ?? '' },
        actionUrl: `${siteBase(options, club.locale)}/klubove/pokana/${token}`,
        replyTo: club.replyTo,
      },
      strings,
    );
    await options.mailer.send({ ...message, to: invite.email });
    return 'sent';
  });
}

async function staffOf(clubId: string, roles: readonly ClubRole[]) {
  return staffRecipients(db(), clubId, roles);
}

// ─── club.notify ────────────────────────────────────────────────────────────

/**
 * Handle one `club.notify` job. The payload is re-validated by
 * parseClubNotifyJob before anything reaches a query.
 */
export async function runClubNotify(
  data: unknown,
  options: ClubMailOptions,
): Promise<{ kind: ClubNotifyJob['kind'] | 'invalid'; report: DeliveryReport }> {
  const job = parseClubNotifyJob(data);
  if (!job) return { kind: 'invalid', report: emptyDeliveryReport() };
  const run = { job: 'club.notify' };
  const base = (club: ClubMailClub, locale: 'bg' | 'en' = club.locale) =>
    `${siteBase(options, locale)}/klub/${club.clubSlug}`;

  switch (job.kind) {
    case 'staff_invite':
    case 'member_invite':
      return {
        kind: job.kind,
        report: await deliverEach([job.inviteId], (id) => sendInvite(job.kind, id, options), run),
      };
    case 'booking_confirmed':
    case 'booking_cancelled':
      return {
        kind: job.kind,
        report: await deliverBookings(job.kind, [job.bookingId], options),
      };
    case 'booking_promoted':
      return {
        kind: job.kind,
        report: await deliverBookings('booking_promoted', job.bookingIds, options),
      };
    case 'event_registered':
      return {
        kind: job.kind,
        report: await deliverEventPlaces(job.kind, [job.registrationId], options),
      };
    case 'event_promoted':
    case 'event_cancelled':
      return {
        kind: job.kind,
        report: await deliverEventPlaces(job.kind, job.registrationIds, options),
      };
    case 'class_cancelled': {
      const bookings = await cancelledOccurrenceBookings(db(), job.occurrenceIds);
      const report = await deliverEach(
        bookings,
        (booking) =>
          sendToMember(
            {
              kind: 'class_cancelled',
              clubId: booking.clubId,
              memberId: booking.memberId,
              key: dedupeKey({
                kind: 'class_cancelled',
                occurrenceId: booking.occurrenceId,
                memberId: booking.memberId,
              }),
              values: { title: booking.title },
              startsAtLocal: booking.startsAtLocal,
              where: booking.locationName,
            },
            options,
          ),
        run,
      );
      return { kind: job.kind, report };
    }
    case 'application_received': {
      const club = await clubForMail(db(), job.clubId);
      if (!club) return { kind: job.kind, report: emptyDeliveryReport() };
      const owners = await staffOf(club.clubId, ['owner']);
      const operators = await operatorRecipients(db());
      const mails: StaffMail[] = [
        ...owners.map((recipient) => ({
          kind: 'application_received' as const,
          club,
          recipient,
          key: dedupeKey({
            kind: 'application_received',
            clubId: club.clubId,
            userId: recipient.userId,
          }),
          ledgerUserId: recipient.userId,
          actionUrl: `${base(club)}/tablo`,
        })),
        ...operators.map((recipient) => ({
          kind: 'operator_new_application' as const,
          club,
          recipient,
          key: dedupeKey({
            kind: 'operator_new_application',
            clubId: club.clubId,
            userId: recipient.userId,
          }),
          ledgerUserId: recipient.userId,
          actionUrl: `${options.siteUrl.replace(/\/+$/, '')}/admin/klubove/${club.clubSlug}`,
          locale: 'bg' as const,
        })),
      ];
      return {
        kind: job.kind,
        report: await deliverEach(mails, (mail) => sendToStaff(mail, options), run),
      };
    }
    case 'application_approved':
    case 'application_rejected': {
      // Rejected: the club is archived, but its owners' staff rows stay — the
      // applicant is told, with where to write (audit 2026-10-30).
      const club = await clubForMail(db(), job.clubId);
      if (!club) return { kind: job.kind, report: emptyDeliveryReport() };
      const owners = await staffOf(club.clubId, ['owner']);
      const kind = job.kind;
      return {
        kind: job.kind,
        report: await deliverEach(
          owners,
          (recipient) =>
            sendToStaff(
              {
                kind,
                club,
                recipient,
                key: dedupeKey({ kind, clubId: club.clubId, userId: recipient.userId }),
                ledgerUserId: recipient.userId,
                actionUrl:
                  kind === 'application_approved'
                    ? `${base(club)}/tablo`
                    : siteBase(options, club.locale),
                values: { contact: options.contactEmail ?? '' },
              },
              options,
            ),
          run,
        ),
      };
    }
    case 'inbox_message': {
      // Read again at send time; a message the other side has already read
      // needs no notice. The notice says THAT there is something to read —
      // never what was written.
      const notice = await inboxNoticeOf(db(), job.messageId);
      const club = notice ? await clubForMail(db(), notice.clubId) : null;
      if (!notice || !club || notice.alreadyRead) {
        return { kind: job.kind, report: emptyDeliveryReport() };
      }
      if (notice.author === 'club') {
        return {
          kind: job.kind,
          report: await deliverEach(
            [notice],
            (n) =>
              sendToMember(
                {
                  kind: 'inbox_reply',
                  clubId: n.clubId,
                  memberId: n.memberId,
                  key: dedupeKey({ kind: 'inbox_reply', messageId: n.messageId }),
                  values: { subject: n.subject },
                  portalPath: `/saobshteniya/${n.threadId}`,
                },
                options,
              ),
            run,
          ),
        };
      }
      // The prospect's owner when they still answer the inbox; else everybody who does.
      const staff = await staffOf(club.clubId, rolesWith('inbox.reply'));
      const owner = staff.find((s) => s.userId === notice.assignedTo);
      const line = (path: string, values: Record<string, string | number>) =>
        fillClubTemplate(pick(club.locale, `inbox.${path}`), values);
      const details =
        notice.threadKind === 'inquiry' && notice.inquiryKind
          ? [
              line('kind', { kind: pick(club.locale, `inbox.kinds.${notice.inquiryKind}`) }),
              ...(notice.inquiryOn
                ? [line('on', { date: formatCivilDate(notice.inquiryOn, club.locale) })]
                : []),
              ...(notice.partySize !== null ? [line('party', { count: notice.partySize })] : []),
            ]
          : [];
      return {
        kind: job.kind,
        report: await deliverEach(
          owner ? [owner] : staff,
          (recipient) =>
            sendToStaff(
              {
                kind: 'inbox_message',
                club,
                recipient,
                key: dedupeKey({
                  kind: 'inbox_message',
                  messageId: notice.messageId,
                  userId: recipient.userId,
                }),
                ledgerUserId: recipient.userId,
                actionUrl: `${base(club)}/vhodyashti/${notice.threadId}`,
                values: { name: notice.memberName, subject: notice.subject },
                details,
              },
              options,
            ),
          run,
        ),
      };
    }
    case 'claim_pending':
    case 'erasure_requested': {
      const member = await memberForStaffMail(db(), job.memberId);
      const club = member ? await clubForMail(db(), member.clubId) : null;
      if (!member || !club) return { kind: job.kind, report: emptyDeliveryReport() };
      const roles = rolesWith(job.kind === 'claim_pending' ? 'members.manage' : 'members.erase');
      const staff = await staffOf(club.clubId, roles);
      return {
        kind: job.kind,
        report: await deliverEach(
          staff,
          (recipient) =>
            sendToStaff(
              {
                kind: job.kind,
                club,
                recipient,
                key: dedupeKey({
                  kind: job.kind,
                  memberId: job.memberId,
                  userId: recipient.userId,
                }),
                ledgerUserId: recipient.userId,
                actionUrl: `${base(club)}/chlenove/${job.memberId}`,
                values: { name: member.memberName },
              },
              options,
            ),
          run,
        ),
      };
    }
  }
}

// ─── Sweeps ─────────────────────────────────────────────────────────────────

/** Every ten minutes: 24-hour reminders not yet sent. The sweep is its own retry. */
export async function runClubReminders(options: ClubMailOptions): Promise<DeliveryReport> {
  const due = await dueClubReminders(db());
  return deliverEach(
    due,
    (booking) =>
      stillApplies('reminder_24h', booking)
        ? sendToMember(
            {
              kind: 'reminder_24h',
              clubId: booking.clubId,
              memberId: booking.memberId,
              key: dedupeKey({
                kind: 'reminder_24h',
                occurrenceId: booking.occurrenceId,
                memberId: booking.memberId,
              }),
              values: { title: booking.title },
              startsAtLocal: booking.startsAtLocal,
              where: booking.locationName,
            },
            options,
          )
        : Promise.resolve('skipped' as const),
    { job: 'club.reminders' },
  );
}

/** Daily: abonnements ending within a week, and those that just ended. */
export async function runClubExpiry(
  options: ClubMailOptions,
  today = sofiaToday(),
): Promise<Record<'membership_expiring' | 'membership_expired', DeliveryReport>> {
  const out = {} as Record<'membership_expiring' | 'membership_expired', DeliveryReport>;
  for (const kind of ['membership_expiring', 'membership_expired'] as const) {
    const candidates = await expiryCandidates(db(), kind, today);
    out[kind] = await deliverEach(
      candidates,
      async (candidate) => {
        const club = await clubForMail(db(), candidate.clubId);
        const locale = club?.locale ?? 'bg';
        return sendToMember(
          {
            kind,
            clubId: candidate.clubId,
            memberId: candidate.memberId,
            key: dedupeKey({ kind, membershipId: candidate.membershipId }),
            values: { plan: candidate.planName, date: formatCivilDate(candidate.endsOn, locale) },
          },
          options,
        );
      },
      { job: 'club.expiry' },
    );
    if (out[kind].transportDown) break;
  }
  return out;
}

/**
 * Daily, with the expiry run: a paying club's own standing, to its owners —
 * the trial ending, coverage run out, the grace over, a suspension (0059),
 * the contract about to renew (0061).
 * Each owner once per milestone (the ledger key carries its date).
 */
export async function runClubLifecycle(
  options: ClubMailOptions,
  today = sofiaToday(),
): Promise<DeliveryReport> {
  const mails: StaffMail[] = [];
  for (const candidate of await clubLifecycleCandidates(db(), today)) {
    const club = await clubForMail(db(), candidate.clubId);
    if (!club) continue;
    for (const recipient of await staffOf(club.clubId, ['owner'])) {
      mails.push({
        kind: candidate.kind,
        club,
        recipient,
        key: dedupeKey({
          kind: candidate.kind,
          clubId: club.clubId,
          userId: recipient.userId,
          anchor: candidate.anchor,
        }),
        ledgerUserId: recipient.userId,
        // The contract's terms are on the settings page; everything else starts at the dashboard.
        actionUrl: `${siteBase(options, club.locale)}/klub/${club.clubSlug}/${
          candidate.kind === 'club_contract_renewing' ? 'nastroyki#dogovor' : 'tablo'
        }`,
        values: {
          date: formatCivilDate(candidate.date, club.locale),
          noticeBy: formatCivilDate(candidate.noticeBy ?? candidate.date, club.locale),
          grace: CLUB_GRACE_DAYS,
          months: CLUB_CONTRACT_MONTHS,
          // «Пишете ни на {contact}» needs somewhere to write: the contact page
          // when no address is configured.
          contact: options.contactEmail ?? `${siteBase(options, club.locale)}/kontakt`,
        },
      });
    }
  }
  return deliverEach(mails, (mail) => sendToStaff(mail, options), { job: 'club.expiry' });
}

/** Daily 06:30: each trainer's classes today, counts only. */
export async function runClubRosterDigest(
  options: ClubMailOptions,
  today = sofiaToday(),
): Promise<DeliveryReport> {
  const rows = await trainerClassesOn(db(), today);
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.clubId}|${row.userId}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return deliverEach(
    [...groups.values()],
    async (classes) => {
      const first = classes[0];
      if (!first) return 'skipped';
      const club = await clubForMail(db(), first.clubId);
      if (!club) return 'skipped';
      const details = classes.map((c) =>
        fillClubTemplate(pick(club.locale, c.capacity === null ? 'rosterLineOpen' : 'rosterLine'), {
          time: c.time,
          title: c.title,
          going: c.going,
          capacity: c.capacity ?? '',
        }),
      );
      return sendToStaff(
        {
          kind: 'roster_daily',
          club,
          recipient: { userId: first.userId, email: first.email, name: first.name },
          key: dedupeKey({ kind: 'roster_daily', userId: first.userId, day: today }),
          ledgerUserId: first.userId,
          actionUrl: `${siteBase(options, club.locale)}/klub/${club.clubSlug}/grafik`,
          details,
        },
        options,
      );
    },
    { job: 'club.digest' },
  );
}

/**
 * Daily 09:05 (0052, «lead not contacted»): each member of staff's prospects
 * to call — new ones nobody called for a day, and next steps due today or
 * late. Counts only; the link opens the board.
 */
export async function runClubLeadsDue(
  options: ClubMailOptions,
  today = sofiaToday(),
): Promise<DeliveryReport> {
  const roles = rolesWith('members.manage');
  const rows = await leadsDue(db(), roles, today);
  const clubs = new Map<string, Awaited<ReturnType<typeof clubForMail>>>();
  const staff = new Map<string, StaffRecipient[]>();
  const mails: StaffMail[] = [];
  for (const row of rows) {
    if (!clubs.has(row.clubId)) clubs.set(row.clubId, await clubForMail(db(), row.clubId));
    if (!staff.has(row.clubId)) staff.set(row.clubId, await staffOf(row.clubId, roles));
    const club = clubs.get(row.clubId);
    const recipient = staff.get(row.clubId)?.find((s) => s.userId === row.userId);
    if (!club || !recipient) continue;
    const line = (path: string, count: number) =>
      fillClubTemplate(pick(club.locale, `leads.${path}`), { count });
    mails.push({
      kind: 'leads_due',
      club,
      recipient,
      key: dedupeKey({ kind: 'leads_due', userId: row.userId, day: today }),
      ledgerUserId: row.userId,
      actionUrl: `${siteBase(options, club.locale)}/klub/${club.clubSlug}/chlenove/potentsialni`,
      values: { count: row.due },
      details: [
        ...(row.uncalled > 0 ? [line('uncalled', row.uncalled)] : []),
        ...(row.planned > 0 ? [line('planned', row.planned)] : []),
      ],
    });
  }
  return deliverEach(mails, (mail) => sendToStaff(mail, options), { job: 'club.leads' });
}

/** Monday 08:30: the owner's numbers for the week that just closed. */
export async function runClubOwnerWeekly(
  options: ClubMailOptions,
  today = sofiaToday(),
): Promise<DeliveryReport> {
  const thisMonday = isoWeekMonday(isoWeekKey(today)) ?? today;
  const lastMonday = addDaysIso(thisMonday, -7);
  const week = isoWeekKey(lastMonday);
  const figures = (await clubWeekFigures(db(), lastMonday)).filter(
    (f) =>
      f.checkins + f.newMembers + f.bookings + f.revenueCents + f.expiringNextWeek > 0 ||
      f.overdueCharges + f.pendingClaims + f.erasureRequests > 0,
  );
  const mails: StaffMail[] = [];
  for (const f of figures) {
    const club = await clubForMail(db(), f.clubId);
    if (!club) continue;
    const line = (path: string, values: Record<string, string | number>) =>
      fillClubTemplate(pick(club.locale, `week.${path}`), values);
    const details = [
      line('checkins', { count: f.checkins }),
      line('newMembers', { count: f.newMembers }),
      line('bookings', { count: f.bookings }),
      line('revenue', { amount: formatEuro(f.revenueCents, club.locale) }),
      line('expiring', { count: f.expiringNextWeek }),
      line('overdue', { count: f.overdueCharges }),
      ...(f.pendingClaims > 0 ? [line('claims', { count: f.pendingClaims })] : []),
      ...(f.erasureRequests > 0 ? [line('erasures', { count: f.erasureRequests })] : []),
    ];
    for (const recipient of await staffOf(club.clubId, ['owner'])) {
      mails.push({
        kind: 'owner_weekly',
        club,
        recipient,
        key: dedupeKey({ kind: 'owner_weekly', userId: recipient.userId, week }),
        ledgerUserId: recipient.userId,
        actionUrl: `${siteBase(options, club.locale)}/klub/${club.clubSlug}/tablo`,
        values: { week },
        details,
      });
    }
  }
  return deliverEach(mails, (mail) => sendToStaff(mail, options), { job: 'club.digest' });
}

/**
 * Daily (0045): renew abonnements and raise no-show / late-cancel fees, then
 * tell the members. The writes come first and stand on their own — a mail
 * failure leaves the renewal in place and tomorrow's sweep mails it.
 */
export async function runClubPolicies(
  options: ClubMailOptions,
  now = new Date(),
): Promise<{
  renewed: number;
  ended: number;
  failed: number;
  fees: number;
  renewalMail: DeliveryReport;
  feeMail: DeliveryReport;
}> {
  const today = sofiaToday(now);
  const renewals = await renewClubMemberships(db(), today);
  const fees = await chargeClubBookingFees(db(), now, (locale) => ({
    noShow: pick(locale, 'feeLabel.noShow'),
    lateCancel: pick(locale, 'feeLabel.lateCancel'),
  }));
  const renewalMail = await deliverEach(
    await renewalMailCandidates(db()),
    async (candidate) => {
      const club = await clubForMail(db(), candidate.clubId);
      const locale = club?.locale ?? 'bg';
      return sendToMember(
        {
          kind: 'membership_renewed',
          clubId: candidate.clubId,
          memberId: candidate.memberId,
          key: dedupeKey({ kind: 'membership_renewed', membershipId: candidate.membershipId }),
          values: {
            plan: candidate.planName,
            from: formatCivilDate(candidate.startsOn, locale),
            to: formatCivilDate(candidate.endsOn, locale),
            amount: formatEuro(candidate.priceCents, locale),
          },
        },
        options,
      );
    },
    { job: 'club.policies' },
  );
  const feeMail = renewalMail.transportDown
    ? emptyDeliveryReport()
    : await deliverEach(
        await feeMailCandidates(db()),
        async (candidate) => {
          const club = await clubForMail(db(), candidate.clubId);
          const locale = club?.locale ?? 'bg';
          return sendToMember(
            {
              kind: 'fee_charged',
              clubId: candidate.clubId,
              memberId: candidate.memberId,
              key: dedupeKey({ kind: 'fee_charged', chargeId: candidate.chargeId }),
              values: {
                label: candidate.label,
                amount: formatEuro(candidate.amountCents, locale),
                date: formatCivilDate(candidate.dueOn, locale),
              },
            },
            options,
          );
        },
        { job: 'club.policies' },
      );
  return { ...renewals, fees, renewalMail, feeMail };
}

/**
 * The 1st of the month: each owner's business-health mail for the month that
 * closed (0045) — counts and shares only, never another member's name, and
 * the plain-language hint the figures support. Clubs with nothing happening
 * get no mail.
 */
export async function runClubHealth(
  options: ClubMailOptions,
  today = sofiaToday(),
): Promise<DeliveryReport> {
  const month = monthStart(addDaysIso(monthStart(today), -1));
  const figures = (await clubMonthFigures(db(), month)).filter(
    (f) => f.members[0] + f.members[1] + f.checkins[0] + f.revenueCents[0] > 0,
  );
  const mails: StaffMail[] = [];
  for (const f of figures) {
    const club = await clubForMail(db(), f.clubId);
    if (!club) continue;
    const line = (path: string, values: Record<string, string | number>) =>
      fillClubTemplate(pick(club.locale, `month.${path}`), values);
    const change = ([now, then]: [number, number]) =>
      then === 0
        ? '—'
        : `${now >= then ? '+' : '−'}${String(Math.round((Math.abs(now - then) / then) * 100))}%`;
    const details = [
      line('members', { now: f.members[0], change: change(f.members) }),
      line('revenue', {
        amount: formatEuro(f.revenueCents[0], club.locale),
        change: change(f.revenueCents),
      }),
      line('checkins', { now: f.checkins[0], change: change(f.checkins) }),
      line('newMembers', { count: f.newMembers }),
      line('churned', { count: f.churned }),
      line('atRisk', { count: f.atRisk }),
      ...(f.topClass
        ? [line('topClass', { title: f.topClass.title, fill: Math.round(f.topClass.fill * 100) })]
        : []),
      '',
      f.atRisk > 0
        ? line('hintAtRisk', { count: f.atRisk })
        : f.churned > f.newMembers
          ? line('hintChurn', {})
          : line('hintSteady', {}),
    ];
    const monthLabel = new Intl.DateTimeFormat(club.locale === 'en' ? 'en-GB' : 'bg', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${month}T12:00:00Z`));
    for (const recipient of await staffOf(club.clubId, ['owner'])) {
      mails.push({
        kind: 'owner_monthly',
        club,
        recipient,
        key: dedupeKey({
          kind: 'owner_monthly',
          userId: recipient.userId,
          month: month.slice(0, 7),
        }),
        ledgerUserId: recipient.userId,
        actionUrl: `${siteBase(options, club.locale)}/klub/${club.clubSlug}/otcheti`,
        values: { month: monthLabel },
        details,
      });
    }
  }
  return deliverEach(mails, (mail) => sendToStaff(mail, options), { job: 'club.health' });
}

/**
 * A member's receipt for an online payment (0046): which plan or charge, and
 * the amount. Not a fiscal document — the club's fiscal duties stay the
 * club's (0041's header) — and the card was handled by Stripe, never here.
 */
export async function runClubReceipts(options: ClubMailOptions): Promise<DeliveryReport> {
  return deliverEach(
    await receiptCandidates(db()),
    async (candidate) => {
      const club = await clubForMail(db(), candidate.clubId);
      const locale = club?.locale ?? 'bg';
      return sendToMember(
        {
          kind: 'payment_received',
          clubId: candidate.clubId,
          memberId: candidate.memberId,
          key: dedupeKey({ kind: 'payment_received', checkoutId: candidate.checkoutId }),
          values: { label: candidate.label, amount: formatEuro(candidate.amountCents, locale) },
        },
        options,
      );
    },
    { job: 'club.payment_event' },
  );
}

/** Monthly: freeze the month that just closed (the invoicing basis). */
export async function runClubActivity(today = sofiaToday()): Promise<{
  month: string;
  recorded: number;
}> {
  const month = monthStart(addDaysIso(monthStart(today), -1));
  const recorded = await recordClubMonthlyActivity(db(), month);
  return { month, recorded };
}

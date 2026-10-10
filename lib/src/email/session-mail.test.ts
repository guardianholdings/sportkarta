import { describe, expect, it } from 'vitest';

import {
  formatLocal,
  renderSessionMail,
  type SessionMailData,
  type SessionMailKind,
  type SessionMailStrings,
} from './session-mail.js';

const STRINGS: SessionMailStrings = {
  locale: 'en',
  subjectConfirmed: 'You are in: {title}',
  subjectWaitlisted: 'Waitlist: {title}',
  subjectPromoted: 'A spot opened: {title}',
  subjectReminder: 'Reminder: {title}',
  subjectCancelled: 'Cancelled: {title}',
  greeting: 'Hi {name},',
  greetingNoName: 'Hi,',
  leadConfirmed: 'You are signed up for {title}.',
  leadWaitlisted: 'You are number {position} on the waitlist for {title}.',
  leadPromoted: 'A spot opened up and you are now going to {title}.',
  leadReminder: '{title} starts in {hours} hours.',
  leadCancelled: '{title} has been cancelled.',
  labelWhen: 'When',
  labelWhere: 'Where',
  labelSpots: 'Spots',
  spots: '{going} of {capacity}',
  spotsUnlimitedOne: '{going} person going',
  spotsUnlimitedOther: '{going} going',
  viewSession: 'Session page',
  addToCalendar: 'Add to calendar',
  withdraw: 'Cannot make it? Withdraw here',
  calendarFeed: 'Subscribe to all your sessions',
  footer: 'SportKarta',
};

const BASE: SessionMailData = {
  kind: 'rsvp_confirmed',
  recipientName: 'Иван',
  title: 'Футбол в Борисовата',
  sport: 'Football',
  startsAtLocal: '2026-07-24T18:00:00',
  facilityName: 'Борисова градина',
  facilityUrl: 'https://pops.bg/obekt/borisova-gradina',
  sessionUrl: 'https://pops.bg/sesiya/abc',
  calendarUrl: 'https://pops.bg/sesiya/abc.ics',
  capacity: 10,
  going: 4,
};

function mail(overrides: Partial<SessionMailData> = {}) {
  return renderSessionMail({ ...BASE, ...overrides }, STRINGS);
}

const ALL_KINDS: SessionMailKind[] = [
  'rsvp_confirmed',
  'rsvp_waitlisted',
  'promoted',
  'reminder_24h',
  'reminder_2h',
  'occurrence_cancelled',
];

describe('formatLocal', () => {
  it("names the weekday and the month, in the mail's language (T-20)", () => {
    // It read «24.07.2026, 18:00» in both languages, with no weekday.
    expect(formatLocal('2026-07-24T18:00:00', 'bg')).toBe('петък, 24 юли 2026 г., 18:00');
    const en = formatLocal('2026-07-24T18:00:00', 'en');
    expect(en).toMatch(/^Friday,? 24 July 2026, 18:00$/);
  });

  it('renders the wall clock as written, with no timezone maths', () => {
    // The bug this guards: constructing a Date from a civil string re-reads it
    // as an instant in the container's zone, and 18:00 arrives as 20:00 —
    // or, just after midnight, on the previous day.
    expect(formatLocal('2026-01-15T18:00:00', 'bg')).toBe('четвъртък, 15 януари 2026 г., 18:00');
    expect(formatLocal('2026-03-29T00:30:00', 'bg')).toBe('неделя, 29 март 2026 г., 00:30');
  });

  it('returns the input unchanged rather than inventing a date', () => {
    expect(formatLocal('not-a-date', 'bg')).toBe('not-a-date');
  });
});

describe('renderSessionMail', () => {
  it('gives every kind its own subject', () => {
    const subjects = ALL_KINDS.map((kind) => mail({ kind }).subject);
    // Reminders share a subject by design (24h and 2h read identically); the
    // rest must be distinguishable in an inbox.
    expect(new Set(subjects).size).toBe(ALL_KINDS.length - 1);
    for (const subject of subjects) expect(subject).not.toContain('{');
  });

  it('never leaves an unfilled placeholder in the body', () => {
    for (const kind of ALL_KINDS) {
      const body = mail({ kind, waitlistPlace: 3, hoursBefore: 24 }).text;
      expect(body).not.toMatch(/\{\w+\}/);
    }
  });

  it('never puts an email address in the subject', () => {
    for (const kind of ALL_KINDS) {
      expect(mail({ kind }).subject).not.toContain('@');
    }
  });

  it('leaves the recipient to the caller — a renderer must not choose one', () => {
    expect(mail().to).toBe('');
  });

  it('states the place on the waitlist it is given', () => {
    // The caller passes the WAITLIST place (position minus capacity); the
    // renderer prints it as is. See db/src/session-mail-recipients.test.ts for
    // the arithmetic against the real view.
    expect(mail({ kind: 'rsvp_waitlisted', waitlistPlace: 1 }).text).toContain(
      'You are number 1 on the waitlist',
    );
  });

  it('greets a member who never set a name without a dangling comma', () => {
    // OTP sign-up creates the account with an empty display name, and the
    // first mail such a member got opened with «Здравейте, ,».
    for (const recipientName of ['', '   ']) {
      const body = mail({ recipientName }).text;
      expect(body.split('\n')[0]).toBe(STRINGS.greetingNoName);
      expect(body).not.toMatch(/Hi\s*,\s*,/);
    }
    expect(mail({ recipientName: '  Иван ' }).text.split('\n')[0]).toBe('Hi Иван,');
  });

  it('carries a withdrawal link in every message that is not a cancellation', () => {
    for (const kind of ALL_KINDS) {
      const body = mail({ kind }).text;
      if (kind === 'occurrence_cancelled') expect(body).not.toContain(STRINGS.withdraw);
      else expect(body).toContain(STRINGS.withdraw);
    }
  });

  it('offers no calendar link on a cancellation — there is nothing to add', () => {
    expect(mail({ kind: 'occurrence_cancelled' }).text).not.toContain(STRINGS.addToCalendar);
  });

  it('omits the attendance count on a cancellation', () => {
    // "4 of 10 going" under "this is cancelled" reads as a mistake.
    expect(mail({ kind: 'occurrence_cancelled' }).text).not.toContain(STRINGS.labelSpots);
  });

  it('says "N going" when the session has no capacity limit', () => {
    expect(mail({ capacity: null, going: 7 }).text).toContain('7 going');
  });

  it('agrees the count with the noun — the singular form for exactly one', () => {
    // A single «{going} записани» printed «1 записани» to the first sign-up.
    expect(mail({ capacity: null, going: 1 }).text).toContain('1 person going');
    expect(mail({ capacity: null, going: 0 }).text).toContain('0 going');
  });

  it('names nobody but the recipient', () => {
    const body = mail().text;
    // No organiser, no other attendee, no address of any kind.
    expect(body).not.toContain('@');
    expect(body.match(/Иван/g)).toHaveLength(1);
  });

  it('points a member with a feed at the profile, never at the feed itself', () => {
    expect(mail().text).not.toContain(STRINGS.calendarFeed);
    const body = mail({ calendarSettingsUrl: 'https://pops.bg/profil' }).text;
    expect(body).toContain(`${STRINGS.calendarFeed}: https://pops.bg/profil`);
    // The feed URL is /kalendar/<token>.ics — a credential. Nothing shaped like
    // one may appear in a message that gets forwarded.
    expect(body).not.toMatch(/\/kalendar\/[A-Za-z0-9_-]{22,}\.ics/);
  });

  it('defaults the reminder lead-in hours from the kind', () => {
    expect(mail({ kind: 'reminder_24h', hoursBefore: undefined }).text).toContain('in 24 hours');
    expect(mail({ kind: 'reminder_2h', hoursBefore: undefined }).text).toContain('in 2 hours');
  });
});

import { describe, expect, it } from 'vitest';

import {
  formatLocal,
  renderSessionMail,
  type SessionMailData,
  type SessionMailKind,
  type SessionMailStrings,
} from './session-mail.js';

const STRINGS: SessionMailStrings = {
  subjectConfirmed: 'You are in: {title}',
  subjectWaitlisted: 'Waitlist: {title}',
  subjectPromoted: 'A spot opened: {title}',
  subjectReminder: 'Reminder: {title}',
  subjectCancelled: 'Cancelled: {title}',
  greeting: 'Hi {name},',
  leadConfirmed: 'You are signed up for {title}.',
  leadWaitlisted: 'You are number {position} on the waitlist for {title}.',
  leadPromoted: 'A spot opened up and you are now going to {title}.',
  leadReminder: '{title} starts in {hours} hours.',
  leadCancelled: '{title} has been cancelled.',
  labelWhen: 'When',
  labelWhere: 'Where',
  labelSpots: 'Spots',
  spots: '{going} of {capacity}',
  spotsUnlimited: '{going} going',
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
  it('renders the wall clock as written, with no timezone maths', () => {
    expect(formatLocal('2026-07-24T18:00:00')).toBe('24.07.2026, 18:00');
  });

  it('does not shift the winter hour either', () => {
    // The bug this guards: constructing a Date from a civil string re-reads it
    // as an instant in the container's zone, and 18:00 arrives as 20:00.
    expect(formatLocal('2026-01-15T18:00:00')).toBe('15.01.2026, 18:00');
  });

  it('returns the input unchanged rather than inventing a date', () => {
    expect(formatLocal('not-a-date')).toBe('not-a-date');
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
      const body = mail({ kind, position: 3, hoursBefore: 24 }).text;
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

  it('states the waitlist position', () => {
    expect(mail({ kind: 'rsvp_waitlisted', position: 3 }).text).toContain('number 3');
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

  it('names nobody but the recipient', () => {
    const body = mail().text;
    // No organiser, no other attendee, no address of any kind.
    expect(body).not.toContain('@');
    expect(body.match(/Иван/g)).toHaveLength(1);
  });

  it('includes the private feed link only when the member has one', () => {
    expect(mail().text).not.toContain(STRINGS.calendarFeed);
    expect(mail({ feedUrl: 'https://pops.bg/kalendar/tok.ics' }).text).toContain(
      'https://pops.bg/kalendar/tok.ics',
    );
  });

  it('defaults the reminder lead-in hours from the kind', () => {
    expect(mail({ kind: 'reminder_24h', hoursBefore: undefined }).text).toContain('in 24 hours');
    expect(mail({ kind: 'reminder_2h', hoursBefore: undefined }).text).toContain('in 2 hours');
  });
});

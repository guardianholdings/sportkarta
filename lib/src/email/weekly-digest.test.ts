import { describe, expect, it } from 'vitest';

import { renderWeeklyDigest, type DigestEntry, type DigestStrings } from './weekly-digest.js';

/**
 * The digest body. The assertions that matter are the ones about what must NOT
 * be in a bulk email: an address in the subject, and a message with no way out.
 */

const strings: DigestStrings = {
  subject: 'Тази седмица в {city}',
  greeting: 'Здравей, {name}! Ето какво се играе тази седмица в {city}.',
  introOne: '{count} тренировка тази седмица.',
  introOther: '{count} тренировки тази седмица.',
  weekdays: ['Понеделник', 'Вторник', 'Сряда', 'Четвъртък', 'Петък', 'Събота', 'Неделя'],
  spots: '{going} от {capacity} места',
  spotsUnlimited: '{going} записани',
  viewWeek: 'Виж цялата седмица',
  unsubscribe: 'Отписване',
  footer: 'Получаваш този имейл, защото си се записал.',
};

const entries: DigestEntry[] = [
  {
    // 2026-09-01 is a Tuesday.
    startsAtLocal: '2026-09-01T18:00:00',
    title: 'Вечерен футбол',
    sport: 'Футбол',
    facilityName: 'Борисова градина',
    facilityUrl: 'https://example.org/obekt/borisova',
    capacity: 12,
    going: 5,
  },
  {
    startsAtLocal: '2026-09-05T10:00:00',
    title: 'Сутрешно бягане',
    sport: 'Бягане',
    facilityName: 'Южен парк',
    capacity: null,
    going: 3,
  },
];

const data = {
  cityName: 'София',
  recipientName: 'Иван',
  entries,
  weekUrl: 'https://example.org/sedmitsata/sofia',
  unsubscribeUrl: 'https://example.org/sedmitsata/otpisvane/tok3n',
};

describe('renderWeeklyDigest', () => {
  it('renders the week grouped by day with local times', () => {
    const message = renderWeeklyDigest(data, strings);
    expect(message).toBeDefined();
    const text = message?.text ?? '';
    expect(text).toContain('Вторник, 2026-09-01');
    expect(text).toContain('Събота, 2026-09-05');
    expect(text).toContain('18:00');
    expect(text).toContain('Вечерен футбол');
    // The wall clock is printed as stored — no second conversion here, which is
    // the only way the mail and the page can agree.
    expect(text).not.toContain('T18:00:00');
  });

  it('always carries an unsubscribe link', () => {
    // A bulk email without a one-click way out is how a sender gets classified
    // as spam, and it is the wrong thing to do regardless.
    const message = renderWeeklyDigest(data, strings);
    expect(message?.text).toContain(data.unsubscribeUrl);
    expect(message?.text).toContain('Отписване');
  });

  it('names the city in the subject and never the recipient', () => {
    const message = renderWeeklyDigest(data, strings);
    // Subjects reach notification previews, logs and bounce reports.
    expect(message?.subject).toBe('Тази седмица в София');
    expect(message?.subject).not.toContain('Иван');
    expect(message?.subject).not.toContain('@');
  });

  it('leaves the recipient address to the caller', () => {
    // The renderer is pure; the address is attached at send time, so it can
    // never end up baked into a cached or logged body.
    expect(renderWeeklyDigest(data, strings)?.to).toBe('');
  });

  it('renders unlimited capacity differently from a full count', () => {
    const text = renderWeeklyDigest(data, strings)?.text ?? '';
    expect(text).toContain('5 от 12 места');
    expect(text).toContain('3 записани');
  });

  it('picks the singular or plural intro without shipping ICU syntax', () => {
    // A half-implemented ICU interpreter previously leaked
    // "{count, plural, one {...} other {...}}" straight into a real inbox.
    const many = renderWeeklyDigest(data, strings)?.text ?? '';
    expect(many).toContain('2 тренировки тази седмица.');
    const one =
      renderWeeklyDigest({ ...data, entries: [entries[0] as DigestEntry] }, strings)?.text ?? '';
    expect(one).toContain('1 тренировка тази седмица.');
    for (const text of [many, one]) {
      expect(text).not.toContain('plural');
      expect(text).not.toContain('#');
    }
  });

  it('returns nothing for an empty week', () => {
    // A mail that says "nothing is on" is not worth an inbox; the job skips.
    expect(renderWeeklyDigest({ ...data, entries: [] }, strings)).toBeUndefined();
  });

  it('omits a facility link when the facility has no slug', () => {
    const text = renderWeeklyDigest(data, strings)?.text ?? '';
    expect(text).toContain('https://example.org/obekt/borisova');
    // The second entry has no URL, so nothing broken like "undefined" appears.
    expect(text).not.toContain('undefined');
  });

  it('interpolates unknown placeholders literally rather than as undefined', () => {
    const message = renderWeeklyDigest(data, { ...strings, subject: 'Hi {nope}' });
    expect(message?.subject).toBe('Hi {nope}');
  });
});

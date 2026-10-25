import { describe, expect, it } from 'vitest';

import {
  CLUB_MAIL_KINDS,
  renderClubMail,
  type ClubMailKind,
  type ClubMailStrings,
} from './club-mail.js';

const perKind = (prefix: string) =>
  Object.fromEntries(CLUB_MAIL_KINDS.map((kind) => [kind, `${prefix} ${kind} {title}`])) as Record<
    ClubMailKind,
    string
  >;

const STRINGS: ClubMailStrings = {
  locale: 'bg',
  subject: perKind('S'),
  lead: { ...perKind('L'), booking_confirmed: 'Записано: „{title}“ ({name}) в {club}.' },
  action: perKind('A'),
  greeting: 'Здравейте, {name},',
  greetingNoName: 'Здравейте,',
  labelWhen: 'Кога',
  labelWhere: 'Къде',
  footer: 'Защото {club} използва POPS.',
  unsubscribe: 'Отписване',
};

describe('renderClubMail', () => {
  const base = {
    kind: 'booking_confirmed' as const,
    clubName: 'Зала Сила',
    recipientName: 'Мария',
    values: { title: 'Йога', name: 'Дете' },
    startsAtLocal: '2026-10-27T18:00:00',
    where: 'Зала 1',
    actionUrl: 'https://pops.bg/klub/zala-sila/az',
  };

  it('names the club in the subject and fills the lead', () => {
    const message = renderClubMail(base, STRINGS);
    expect(message.subject).toBe('Зала Сила · S booking_confirmed Йога');
    expect(message.text).toContain('Здравейте, Мария,');
    expect(message.text).toContain('Записано: „Йога“ (Дете) в Зала Сила.');
    expect(message.text).toContain('Къде: Зала 1');
    expect(message.text).toContain('18:00');
    expect(message.text).toContain(
      'A booking_confirmed {title}: https://pops.bg/klub/zala-sila/az',
    );
  });

  it('carries no opt-out for a linked member', () => {
    const message = renderClubMail(base, STRINGS);
    expect(message.headers?.['List-Unsubscribe']).toBeUndefined();
    expect(message.text).not.toContain('Отписване');
  });

  it('gives an unlinked recipient a body link and RFC 8058 one-click headers', () => {
    const message = renderClubMail(
      {
        ...base,
        unsubscribePageUrl: 'https://pops.bg/klubove/otpisvane/abc',
        unsubscribePostUrl: 'https://pops.bg/api/clubs/otpisvane/abc',
      },
      STRINGS,
    );
    expect(message.text).toContain('Отписване: https://pops.bg/klubove/otpisvane/abc');
    expect(message.headers).toMatchObject({
      'List-Unsubscribe': '<https://pops.bg/api/clubs/otpisvane/abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('sets Reply-To only for a well-formed club address', () => {
    expect(renderClubMail({ ...base, replyTo: 'info@zala.bg' }, STRINGS).headers).toMatchObject({
      'Reply-To': 'info@zala.bg',
    });
    expect(
      renderClubMail({ ...base, replyTo: 'x@y.bg\r\nBcc: z@w.bg' }, STRINGS).headers?.['Reply-To'],
    ).toBeUndefined();
  });

  it('cannot fold the subject, whatever the club name holds', () => {
    const message = renderClubMail({ ...base, clubName: 'Зала\r\nBcc: x@y.z' }, STRINGS);
    expect(message.subject).not.toMatch(/[\r\n]/);
  });

  it('greets without a name when there is none', () => {
    expect(renderClubMail({ ...base, recipientName: ' ' }, STRINGS).text).toMatch(/^Здравейте,\n/);
  });
});

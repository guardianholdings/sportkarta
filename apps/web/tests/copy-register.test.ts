import { describe, expect, it } from 'vitest';

import bg from '../messages/bg.json';

/**
 * The register of the session, digest, passport and training copy (UX audit
 * 2026-10-10).
 *
 * The product addresses its reader formally (Вие). The exceptions are the
 * friend-to-friend share texts — words the member sends to a friend, where «ти»
 * is the natural voice — and those are pinned below as the exception, so a
 * well-meant sweep does not "fix" them.
 */
interface Tree {
  [key: string]: string | Tree;
}

function value(path: string): string {
  let node: string | Tree = bg as unknown as Tree;
  for (const part of path.split('.')) {
    if (typeof node === 'string') throw new Error(`${path}: not a namespace`);
    const next: string | Tree | undefined = node[part];
    if (next === undefined) throw new Error(`${path}: missing`);
    node = next;
  }
  if (typeof node !== 'string') throw new Error(`${path}: not a message`);
  return node;
}

function strings(node: Tree, prefix: string): [string, string][] {
  return Object.entries(node).flatMap(([key, child]) =>
    typeof child === 'string' ? [[`${prefix}.${key}`, child]] : strings(child, `${prefix}.${key}`),
  );
}

/** Second-person-singular markers that turned up in these keys. */
const INFORMAL =
  /(?<![\p{L}])(Виж|Влез|Запиши|Абонирай|Върни|разгледай|твои|твоите|Имаш|получиш|играеш|споделяй|публикувай|абонираш|Здравей|Получаваш|Натисни|спреш|влизаш|се запишеш|си се записал|Записан си|Отписан си)(?![\p{L}])/u;

const FORMAL_KEYS = [
  'Session.metaDescription',
  'Session.metaDescriptionNoPlace',
  'Session.youAreGoing',
  'Session.youAreWaitlisted',
  'Session.fullHint',
  'Session.signInToJoin',
  'Session.subscribeAll',
  'Session.feedHeading',
  'Session.feedIntro',
  'Session.feedSecretWarning',
  'Session.feedRotateHint',
  'Session.indexIntro',
  'Session.indexEmptyBody',
  'Digest.subscribe',
  'Digest.subscribed',
  'Digest.unsubscribed',
  'Digest.unsubscribeConfirmBody',
  'Digest.emptyHint',
  'DigestEmail.greeting',
  'DigestEmail.greetingNoName',
  'DigestEmail.footer',
  'Passport.activityExplainer',
];

describe('formal address', () => {
  it.each(FORMAL_KEYS)('%s addresses the reader as Вие', (key) => {
    expect(value(key)).not.toMatch(INFORMAL);
  });

  it('keeps «ти» where a member is talking to a friend', () => {
    for (const key of [
      'Og.session.cta',
      'ShareSheet.textSession',
      'ShareSheet.textCampaign',
      'Story.callToAction',
      'Story.session.callToAction',
      'AuthEmail.motto',
    ]) {
      expect(() => value(key), key).not.toThrow();
    }
    expect(value('ShareSheet.textSession')).toContain('Ела и ти');
  });
});

describe('terminology', () => {
  it('calls a group session «тренировка», never «сесия» (a login session)', () => {
    const offenders = [
      'Session',
      'Digest',
      'DigestEmail',
      'SessionEmail',
      'Checkin',
      'Roster',
      'Passport',
      'Training',
      'Badge',
      'Leaderboard',
      'Participation',
      'Division',
      'Campaign',
    ].flatMap((ns) =>
      strings((bg as unknown as Tree)[ns] as Tree, ns).filter(([, text]) => /сеси[яи]/u.test(text)),
    );
    expect(offenders).toEqual([]);
  });

  it('says «мин.» with the full stop, like the rest of the product', () => {
    expect(value('Training.durationMinutes')).toBe('{minutes} мин.');
    expect(value('Roster.checkinClosedHint')).toContain('мин. преди');
  });
});

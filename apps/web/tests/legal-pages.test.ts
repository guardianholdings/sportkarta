import { renderModerationMail, type ModerationMailStrings } from '@sportkarta/lib/email';
import { allReasonSlugs } from '@sportkarta/lib/moderation';
import { describe, expect, it } from 'vitest';

import {
  PRIVACY_ACTIVITIES,
  PRIVACY_PROVIDER_ONLY,
  PRIVACY_RECIPIENTS,
  PRIVACY_RETENTION,
  TERMS_SECTIONS,
} from '@/lib/legal-pages';
import { NOTICE_CATEGORIES } from '@/lib/notice-input';

import bg from '../messages/bg.json';

/**
 * The legal pages, the notice form and the moderation mail print keys that a
 * typo would turn into a raw key name on a page a regulator reads, or into a
 * formatting error in a statement of reasons. Parity with en.json is the i18n
 * test's job; this proves the keys EXIST (in bg, so in both) and that every
 * rich-text tag a message uses is one its renderer supplies.
 */

interface Tree {
  [key: string]: string | Tree;
}
const messages = bg as unknown as Tree;

function lookup(path: string): string | Tree | undefined {
  return path.split('.').reduce<string | Tree | undefined>((node, key) => {
    return typeof node === 'object' ? node[key] : undefined;
  }, messages);
}

function expectString(path: string): string {
  const value = lookup(path);
  expect(typeof value, path).toBe('string');
  return value as string;
}

function leaves(node: string | Tree, path: string): [string, string][] {
  if (typeof node === 'string') return [[path, node]];
  return Object.entries(node).flatMap(([key, child]) => leaves(child, `${path}.${key}`));
}

function tagsOf(message: string): string[] {
  return [...message.matchAll(/<([a-zA-Z]+)>/g)].map((m) => m[1] as string);
}

/** The tags components/legal/legal-links.tsx provides, plus page-specific ones. */
const LEGAL_TAGS = ['privacy', 'terms', 'contact', 'form', 'profile', 'openData'];

describe('the privacy notice', () => {
  it('has every section the page prints', () => {
    for (const key of PRIVACY_ACTIVITIES) {
      for (const part of ['title', 'body', 'basis'])
        expectString(`Privacy.processing.${key}.${part}`);
    }
    for (const key of PRIVACY_RECIPIENTS) expectString(`Privacy.recipients.${key}`);
    for (const key of PRIVACY_RETENTION) expectString(`Privacy.retention.${key}`);
    for (const path of [
      'controller.title',
      'controller.body',
      'transfers.body',
      'rights.body',
      'rights.self',
      'rights.ask',
      'rights.complaint',
      'cookies.body',
      'cookies.providers',
      'cookies.cache',
      'minors.body',
      'automated.body',
      'sources.body',
      'changes.body',
    ]) {
      expectString(`Privacy.${path}`);
    }
  });

  it('prints the notifier retention from the constant, not as a typed number', () => {
    expect(expectString('Privacy.retention.notices')).toContain('{days}');
    expect(expectString('Notice.contactHint')).toContain('{days}');
  });

  it('prints the code lifetime from OTP_TTL_SECONDS, not as a typed number', () => {
    expect(expectString('Privacy.retention.codes')).toContain('{minutes}');
    expect(expectString('SignIn.codeHint')).toContain('{minutes}');
  });

  it('names only the sign-in providers that are on, and only while one is', () => {
    for (const key of PRIVACY_PROVIDER_ONLY) {
      expect([...PRIVACY_ACTIVITIES, ...PRIVACY_RECIPIENTS] as string[]).toContain(key);
    }
    for (const path of [
      'processing.signInProviders.title',
      'processing.signInProviders.body',
      'recipients.signInProviders',
      'cookies.providers',
    ]) {
      expect(expectString(`Privacy.${path}`), path).toContain('{providers}');
    }
  });

  it('uses only link tags the page supplies', () => {
    for (const [path, message] of leaves(messages.Privacy as Tree, 'Privacy')) {
      for (const tag of tagsOf(message)) {
        expect([...LEGAL_TAGS, 'cpdp'], `${path} <${tag}>`).toContain(tag);
      }
    }
  });
});

describe('the terms of use', () => {
  it('has every numbered section, paragraph and list item the page prints', () => {
    for (const section of TERMS_SECTIONS) {
      expectString(`Terms.${section.key}.title`);
      for (const paragraph of section.paragraphs) expectString(`Terms.${section.key}.${paragraph}`);
      for (const item of section.items ?? []) expectString(`Terms.${section.key}.items.${item}`);
    }
  });

  it('uses only link tags the page supplies', () => {
    for (const [path, message] of leaves(messages.Terms as Tree, 'Terms')) {
      for (const tag of tagsOf(message)) expect(LEGAL_TAGS, `${path} <${tag}>`).toContain(tag);
    }
  });
});

describe('the contact page and the notice form', () => {
  it('labels every identity field', () => {
    for (const field of ['legalName', 'eik', 'address']) expectString(`Contact.label.${field}`);
  });

  it('labels every notice category and every error the action can return', () => {
    for (const category of NOTICE_CATEGORIES) expectString(`Notice.category.${category}`);
    for (const error of [
      'url',
      'category',
      'explanation',
      'name',
      'email',
      'goodFaith',
      'tooFast',
      'expired',
      'rateLimited',
      'unknown',
    ]) {
      expectString(`Notice.error.${error}`);
    }
  });

  it('uses only the tags each renderer supplies', () => {
    const allowed: Record<string, string[]> = {
      'Contact.emailLine': ['email'],
      'Contact.noEmail': ['form'],
      'Contact.topicData': ['privacy'],
      'Contact.topicContent': ['form'],
      'Contact.topicSupport': ['support', 'partners'],
      'Contact.legalLinks': ['terms', 'privacy'],
      'Notice.otherChannels': ['report', 'contact'],
      'Notice.termsNote': ['terms'],
      'SignIn.privacyNote': ['terms', 'privacy'],
      'Podkrepi.contactFallback': ['contact'],
      'Partners.contactFallback': ['contact'],
    };
    for (const [path, tags] of Object.entries(allowed)) {
      expect(tagsOf(expectString(path)).sort(), path).toEqual([...tags].sort());
    }
    for (const [path, message] of [
      ...leaves(messages.Contact as Tree, 'Contact'),
      ...leaves(messages.Notice as Tree, 'Notice'),
    ]) {
      if (!(path in allowed)) expect(tagsOf(message), path).toEqual([]);
    }
  });
});

describe('moderation reasons and mail', () => {
  it('labels every reason slug a moderator can pick', () => {
    for (const slug of allReasonSlugs()) expectString(`ModerationReason.${slug}`);
  });

  it('renders every kind of moderation mail with no placeholder left unfilled', () => {
    // Typed assignment: a key missing from bg.json fails typecheck here.
    const strings: ModerationMailStrings = bg.ModerationEmail;
    const kinds = [
      'photo_rejected',
      'photo_removed',
      'facility_removed',
      'notice_received',
      'notice_actioned',
      'notice_dismissed',
    ] as const;
    for (const kind of kinds) {
      for (const contactEmail of ['hello@pops.test', null]) {
        const mail = renderModerationMail(
          {
            kind,
            facilityName: 'Борисова градина',
            notice: { receivedOn: '29.09.2026', categoryLabel: bg.Notice.category.abuse },
            reasonLabel: 'Причина',
            ground: 'terms',
            date: '30.09.2026',
            termsUrl: 'https://pops.test/usloviya',
            noticeFormUrl: 'https://pops.test/signal',
            contactEmail,
          },
          strings,
        );
        expect(`${mail.subject}\n${mail.text}`, `${kind} ${String(contactEmail)}`).not.toMatch(
          /\{\w+\}/,
        );
      }
    }
  });
});

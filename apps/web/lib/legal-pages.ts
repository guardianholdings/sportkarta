import type { ClubSwitch } from '@/lib/clubs/features';

/**
 * The shape of the three legal documents — which sections, in which order, with
 * which paragraphs — kept out of the page files so a test can prove every key
 * they print exists in messages/bg.json (and, by the parity test, in en.json).
 * A missing legal paragraph must fail CI, not render as its own key name.
 *
 * The WORDS live in messages/*.json (Privacy.*, Terms.*, ClubTerms.*); bg is
 * authoritative.
 */

/** /privacy: each processing activity — `title`, `body`, `basis`. */
export const PRIVACY_ACTIVITIES = [
  'browsing',
  'analytics',
  'account',
  // Printed only while at least one of Google, Apple or Facebook is switched
  // on (PRIVACY_PROVIDER_ONLY): the page describes what the site really does.
  'signInProviders',
  'contributions',
  'location',
  'passport',
  'sessions',
  'training',
  'mail',
  'reports',
  'notices',
  'moderation',
  'tokens',
  // Printed only while CLUBS_ENABLED is on (PRIVACY_SWITCH_ONLY): the clubs
  // module processes club members' records on each club's behalf (Art. 28).
  'clubs',
  // Printed only while CLUB_PUSH_ENABLED is on: a member's device opts in from
  // the club portal, and the subscription is stored on their POPS account.
  'push',
] as const;

/** /privacy: recipients, one bullet each. */
export const PRIVACY_RECIPIENTS = [
  'hosting',
  'network',
  'mail',
  // Printed only while CLUB_PAYMENTS_ENABLED is on: a member paying a club
  // online pays into the club's own Stripe account.
  'payments',
  'people',
  'external',
  'signInProviders',
  'noSale',
] as const;

/**
 * Keys of the lists above that /privacy prints only while a sign-in provider is
 * on (lib/auth-config.ts enabledSignInProviders). With every flag off — how the
 * providers ship — the notice reads exactly as it did before them.
 */
export const PRIVACY_PROVIDER_ONLY: ReadonlySet<string> = new Set(['signInProviders']);

/**
 * Keys of the lists above that /privacy prints only while a club switch is on:
 * `clubs` means CLUBS_ENABLED itself (lib/clubs/access.ts clubsEnabled), any
 * other value is a service switch (lib/clubs/features.ts clubSwitchOn) that
 * also presumes the module is on. Same rule as the sign-in providers: the
 * notice describes what the site really does, so with the switches off — how
 * they ship — it reads as if the feature did not exist.
 */
export const PRIVACY_SWITCH_ONLY: Readonly<Record<string, 'clubs' | ClubSwitch>> = {
  clubs: 'clubs',
  push: 'push',
  payments: 'payments',
};

/** /privacy: retention, one bullet each. */
export const PRIVACY_RETENTION = [
  'account',
  'codes',
  'sessions',
  'contributions',
  'notices',
  'logs',
  'errors',
  'backups',
  // Printed only while CLUBS_ENABLED is on (PRIVACY_SWITCH_ONLY).
  'clubs',
] as const;

export interface TermsSection {
  key: string;
  paragraphs: readonly string[];
  /** A bulleted list under the paragraphs, `<key>.items.<item>`. */
  items?: readonly string[];
  /** Render `items` as a numbered list (the clauses of an annex). */
  numbered?: boolean;
  /** Print the association's identity block (components/legal). */
  org?: boolean;
}

/** /usloviya, numbered in this order. */
export const TERMS_SECTIONS: readonly TermsSection[] = [
  { key: 'who', paragraphs: ['body'], org: true },
  { key: 'service', paragraphs: ['body'] },
  { key: 'account', paragraphs: ['body', 'age'] },
  {
    key: 'content',
    paragraphs: ['body'],
    items: ['illegal', 'personalData', 'people', 'abuse', 'spam', 'falseData', 'rights'],
  },
  { key: 'licence', paragraphs: ['data', 'photos'] },
  { key: 'moderation', paragraphs: ['how', 'reasons', 'restrictions'] },
  { key: 'notices', paragraphs: ['body', 'contest', 'point'] },
  { key: 'accuracy', paragraphs: ['body', 'risk'] },
  { key: 'privacy', paragraphs: ['body'] },
  { key: 'changes', paragraphs: ['body'] },
  { key: 'law', paragraphs: ['body'] },
];

/**
 * /usloviya-klubove — «Условия за POPS Клубове»: the contract a club accepts
 * when it applies (/klubove/zayavka), with Annex A, the Art. 28 GDPR data
 * processing agreement. The club is the controller of its members' records
 * and the association the processor; for the members' own POPS accounts the
 * roles are those of /privacy.
 *
 * VERSION. The date of the text the applicant was shown. apply.ts writes it
 * into the club's audit row with the acceptance time, so a later edition can
 * never blur what a club agreed to: change the words, bump the date.
 *
 * DRAFT. The text was written by the team from how the code behaves and is
 * awaiting the association's lawyer. While CLUB_TERMS_DRAFT is true the page
 * prints ClubTerms.draftNotice above the text; after approval the operator
 * flips it to false (this one line) and bumps CLUB_TERMS_VERSION to the
 * approval date.
 */
export const CLUB_TERMS_VERSION = '2026-10-31';
export const CLUB_TERMS_DRAFT = true;

/**
 * How many days ahead a change to the clubs terms, or to the sub-processor
 * list in Annex A, is announced to the owners (`{noticeDays}` in the text).
 * Deliberately its own constant: CLUB_CONTRACT_REMINDER_DAYS is a reminder
 * schedule, not a notice period, and the two may diverge.
 */
export const CLUB_TERMS_CHANGE_NOTICE_DAYS = 30;

/**
 * /usloviya-klubove, numbered in this order. The figures the text states —
 * `{days}` trial, `{months}` term, `{notice}` months of notice, `{grace}` days
 * after non-payment, `{purgeDays}` after archiving, `{noticeDays}` for changes
 * — are passed in from the constants, never typed (tests/clubs-landing.test.ts
 * refuses a typed term in ClubTerms as it does in the landing copy).
 */
export const CLUB_TERMS_SECTIONS: readonly TermsSection[] = [
  { key: 'who', paragraphs: ['subject', 'club', 'association'], org: true },
  { key: 'trial', paragraphs: ['apply', 'trial', 'features'] },
  { key: 'contract', paragraphs: ['term', 'invoicing', 'nonPayment'] },
  { key: 'service', paragraphs: ['what', 'not', 'availability', 'support'] },
  {
    key: 'clubDuties',
    paragraphs: ['body'],
    items: ['lawful', 'consents', 'accurate', 'messaging', 'fiscal', 'content', 'staff'],
  },
  { key: 'dataRoles', paragraphs: ['records', 'accounts', 'limits'] },
  { key: 'payments', paragraphs: ['own', 'fee', 'refunds'] },
  { key: 'termination', paragraphs: ['notice', 'suspension', 'end', 'accounts'] },
  { key: 'liability', paragraphs: ['cap', 'exclusions'] },
  { key: 'changes', paragraphs: ['body'] },
  { key: 'law', paragraphs: ['body'] },
  {
    key: 'annex',
    paragraphs: ['intro'],
    numbered: true,
    items: [
      'subject',
      'nature',
      'data',
      'subjects',
      'instructions',
      'confidentiality',
      'security',
      'rights',
      'dpia',
      'breach',
      'end',
      'audit',
      'subprocessors',
      'transfers',
      'controller',
    ],
  },
];

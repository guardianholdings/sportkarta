/**
 * The shape of the two legal documents — which sections, in which order, with
 * which paragraphs — kept out of the page files so a test can prove every key
 * they print exists in messages/bg.json (and, by the parity test, in en.json).
 * A missing legal paragraph must fail CI, not render as its own key name.
 *
 * The WORDS live in messages/*.json (Privacy.*, Terms.*); bg is authoritative.
 */

/** /privacy: each processing activity — `title`, `body`, `basis`. */
export const PRIVACY_ACTIVITIES = [
  'browsing',
  'analytics',
  'account',
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
] as const;

/** /privacy: recipients, one bullet each. */
export const PRIVACY_RECIPIENTS = [
  'hosting',
  'network',
  'mail',
  'people',
  'external',
  'noSale',
] as const;

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
] as const;

export interface TermsSection {
  key: string;
  paragraphs: readonly string[];
  /** A bulleted list under the paragraphs, `<key>.items.<item>`. */
  items?: readonly string[];
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

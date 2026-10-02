/**
 * The public notice form's input (/signal — DSA Art. 16, migration 0033), as
 * PURE code: no database, no server-only import, so the client form can share
 * the categories and the bounds with the server action that re-checks them.
 * The statements that store and decide a notice live in `lib/notices.ts`.
 *
 * WHAT A NOTICE IS. Art. 16(2) lists what makes a notice actionable: where the
 * content is (a URL), why it is illegal or against the rules (an explanation),
 * who is sending it (a name and address — optional here, because a notice about
 * one's own photo or about a crime must not require identifying oneself), and a
 * statement of good faith. The parser below accepts exactly that and nothing
 * else; the database CHECKs in 0033 repeat every bound, so a request that
 * skipped this file entirely would still be refused.
 */

export const NOTICE_CATEGORIES = [
  'illegal',
  'personal_data',
  'rights',
  'abuse',
  'spam',
  'other',
] as const;
export type NoticeCategory = (typeof NOTICE_CATEGORIES)[number];

export const MAX_NOTICE_URL = 500;
export const MAX_NOTICE_EXPLANATION = 2000;
export const MAX_NOTICE_NAME = 120;
export const MAX_NOTICE_EMAIL = 254;

export interface NoticeInput {
  targetUrl: string;
  category: NoticeCategory;
  explanation: string;
  notifierName: string | null;
  notifierEmail: string | null;
}

/** Which field was wrong — an i18n key suffix under `Notice.error`. */
export type NoticeProblem = 'url' | 'category' | 'explanation' | 'name' | 'email' | 'goodFaith';

export interface NoticeFields {
  url: unknown;
  category: unknown;
  explanation: unknown;
  name: unknown;
  email: unknown;
  goodFaith: unknown;
}

// Whitespace and control characters: nothing a real URL contains, and the
// characters a smuggled second line or header would need. And the backslash,
// which a browser reads as a slash: `/\evil.example` is `//evil.example`,
// somebody else's host behind what looks like a path on ours.
// eslint-disable-next-line no-control-regex
const UNSAFE_URL_CHARS = /[\s\u0000-\u001f\u007f\\]/;
const ABSOLUTE_HTTP = /^https?:\/\//i;
const EMAIL_SHAPE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A reported location: an absolute http(s) URL, or a path on this site. Anything
 * else — `javascript:`, `data:`, a protocol-relative `//host` — is refused,
 * because the admin queue renders the value as a link. A site path may not
 * carry another URL inside it (`/https://evil.example/login`): no POPS path
 * does, and it is how a "path" smuggles in somebody else's host. The 0033 CHECK
 * `content_notices_target_url_shape` repeats every rule here.
 *
 * Whatever passes is still the notifier's own text, so it is shown to the
 * admin and NEVER mailed back (lib/src/email/moderation-mail.ts).
 */
export function parseNoticeUrl(value: unknown): string | null {
  const url = str(value);
  if (!url || url.length > MAX_NOTICE_URL || UNSAFE_URL_CHARS.test(url)) return null;
  if (url.startsWith('/')) return url.startsWith('//') || url.includes('://') ? null : url;
  // The scheme as typed, not as `new URL` would normalise it: `https:evil.example`
  // parses, but it is not what the CHECK (and a reader) expect a URL to look like.
  if (!ABSOLUTE_HTTP.test(url)) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }
  return url;
}

/**
 * A path handed to the form by a "report this" link (`/signal?url=/pasport/…`).
 * Stricter than what a person may type: only a same-site path, so the form can
 * never be pre-filled from outside with somebody else's URL.
 */
export function prefillPath(value: unknown): string {
  const url = parseNoticeUrl(value);
  return url?.startsWith('/') ? url : '';
}

export function parseNotice(
  fields: NoticeFields,
): { ok: true; value: NoticeInput } | { ok: false; problem: NoticeProblem } {
  const targetUrl = parseNoticeUrl(fields.url);
  if (!targetUrl) return { ok: false, problem: 'url' };

  const category = str(fields.category);
  if (!(NOTICE_CATEGORIES as readonly string[]).includes(category)) {
    return { ok: false, problem: 'category' };
  }

  const explanation = str(fields.explanation);
  if (!explanation || explanation.length > MAX_NOTICE_EXPLANATION) {
    return { ok: false, problem: 'explanation' };
  }

  const name = str(fields.name).replace(/\s+/g, ' ');
  if (name.length > MAX_NOTICE_NAME) return { ok: false, problem: 'name' };

  const email = str(fields.email);
  if (email && (email.length > MAX_NOTICE_EMAIL || !EMAIL_SHAPE.test(email))) {
    return { ok: false, problem: 'email' };
  }

  // The checkbox posts "on" when ticked and nothing at all when not.
  if (fields.goodFaith !== 'on' && fields.goodFaith !== 'true') {
    return { ok: false, problem: 'goodFaith' };
  }

  return {
    ok: true,
    value: {
      targetUrl,
      category: category as NoticeCategory,
      explanation,
      notifierName: name || null,
      notifierEmail: email || null,
    },
  };
}

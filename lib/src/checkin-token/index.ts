import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed, expiring check-in tokens (docs/ROADMAP.md §7, Stage 5.4).
 *
 * A check-in row is a claim that a named person was at a place at a time, and
 * from 5.4 it is worth points. So the question this file answers is: what makes
 * that claim worth anything?
 *
 * THE TOKEN IS THE ORGANISER'S PRESENCE, NOT THE MEMBER'S. It is derived from a
 * server secret and displayed as a QR code on the organiser's own screen at the
 * session. Holding a currently-valid token means being close enough to somebody
 * who is running the session to read their phone. That is the whole security
 * claim, and it is deliberately modest.
 *
 * WINDOWED, NOT TIMESTAMPED. The token encodes a window index — `floor(now /
 * WINDOW_MS)` — rather than an issue time. Three things follow:
 *
 *   - The QR is STABLE for a window, so the organiser's screen is not
 *     re-rendering under somebody's camera mid-scan.
 *   - Verification needs no storage. There is no issued-token table to write,
 *     to clean up, or to fall out of sync with a second web container.
 *   - Replay is bounded by arithmetic rather than by revocation: a photograph
 *     of the QR sent to a friend across town stops working within two minutes,
 *     and no request has to notice that it was shared.
 *
 * The previous window is accepted as well as the current one, so a scan that
 * starts at 59.9 s does not fail. Effective validity is therefore between one
 * and two windows.
 *
 * NO SECRETS AND NO IDENTIFIERS IN THE TOKEN. It names the occurrence, which is
 * a public object with its own public page, and nothing else. It does not name
 * the member — it cannot, because it is printed once for everybody in the park.
 * Who checked in is decided by the session cookie on the request that redeems
 * it, never by the token.
 */

/** One minute. Long enough to scan, short enough that a screenshot decays. */
export const WINDOW_MS = 60_000;

/** How many past windows still verify. 1 = the current and the previous. */
export const GRACE_WINDOWS = 1;

/** Truncated to 16 bytes: 128 bits of tag is far past what this needs. */
const TAG_BYTES = 16;

const VERSION = 'v1';

/**
 * Field separator. NOT a dot, and that is load-bearing: the token travels as a
 * URL PATH SEGMENT, and apps/web/middleware.ts skips any path containing a dot
 * (it is how the sitemaps and .ics routes opt out of locale rewriting). A
 * dot-separated token would silently bypass the i18n middleware and 404.
 * `~` is unreserved in RFC 3986, so it survives a round trip untouched.
 */
const SEP = '~';

export interface CheckinTokenInput {
  occurrenceId: string;
  secret: string;
  /** Defaults to now; injected in tests. */
  at?: Date;
}

export function windowIndexFor(at: Date): number {
  return Math.floor(at.getTime() / WINDOW_MS);
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret)
    .update(payload)
    .digest()
    .subarray(0, TAG_BYTES)
    .toString('base64url');
}

function payloadFor(occurrenceId: string, window: number): string {
  return [VERSION, occurrenceId, String(window)].join(SEP);
}

/**
 * The token the QR encodes. URL-safe with no padding, so it drops into a path
 * segment without escaping.
 */
export function issueCheckinToken({
  occurrenceId,
  secret,
  at = new Date(),
}: CheckinTokenInput): string {
  if (!secret) throw new Error('a check-in secret is required');
  const window = windowIndexFor(at);
  const payload = payloadFor(occurrenceId, window);
  return `${payload}${SEP}${sign(secret, payload)}`;
}

export type CheckinTokenFailure = 'malformed' | 'unsupported_version' | 'expired' | 'bad_signature';

export type CheckinTokenResult =
  { ok: true; occurrenceId: string; window: number } | { ok: false; reason: CheckinTokenFailure };

/**
 * Verify a token against the current clock.
 *
 * ORDER MATTERS. The signature is checked BEFORE the window, so an attacker
 * cannot use the difference between "expired" and "bad signature" to learn
 * whether a forged signature happened to be right — and the comparison is
 * `timingSafeEqual`, not `===`, so it cannot be walked byte by byte either.
 * Both are cheap; the alternative is a subtle oracle in the one endpoint that
 * hands out points.
 */
export function verifyCheckinToken(
  token: string,
  secret: string,
  at: Date = new Date(),
): CheckinTokenResult {
  if (!secret) return { ok: false, reason: 'bad_signature' };

  const parts = token.split(SEP);
  if (parts.length !== 4) return { ok: false, reason: 'malformed' };
  const [version, occurrenceId, windowText, tag] = parts as [string, string, string, string];
  if (version !== VERSION) return { ok: false, reason: 'unsupported_version' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(occurrenceId)) {
    return { ok: false, reason: 'malformed' };
  }
  if (!/^\d{1,15}$/.test(windowText)) return { ok: false, reason: 'malformed' };
  const window = Number(windowText);

  const expected = sign(secret, payloadFor(occurrenceId, window));
  const given = Buffer.from(tag, 'base64url');
  const wanted = Buffer.from(expected, 'base64url');
  // timingSafeEqual throws on a length mismatch, which is itself a signal —
  // so the length is checked first and both branches return the same reason.
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const current = windowIndexFor(at);
  // A token from the future is refused as firmly as an old one: it would mean
  // a clock skew big enough that the expiry guarantee no longer holds.
  if (window > current || window < current - GRACE_WINDOWS) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, occurrenceId, window };
}

/**
 * Milliseconds until the current window ends — what the organiser's screen uses
 * to decide when to refresh. Always at least a second, so a refresh scheduled
 * right on a boundary does not spin.
 */
export function msUntilNextWindow(at: Date = new Date()): number {
  return Math.max(1000, WINDOW_MS - (at.getTime() % WINDOW_MS));
}

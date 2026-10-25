import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Server-only secrets for the club module. Every one of them is shown to a
 * person exactly once (in a mail link, on a printed card, on the tablet being
 * paired) and stored ONLY as a SHA-256 hex digest, in columns that 0039/0040
 * CHECK-pin to 64 hex characters so they cannot hold the secret itself (the
 * api_keys.key_hash rule, 0015).
 *
 * Never import this from a client component: it pulls in node:crypto.
 */

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison of two hex digests of equal length. */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/**
 * An invite token for a mail link: 32 random bytes, base64url, no padding —
 * safe as a URL path segment (no dot, which the i18n middleware treats as a
 * file extension; see lib/src/checkin-token).
 */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export const CARD_KEY_PREFIX = 'skbc_';

/** A printed member card's key. The prefix makes a leaked one recognisable. */
export function generateCardKey(): string {
  return `${CARD_KEY_PREFIX}${randomBytes(18).toString('base64url')}`;
}

export function isCardKeyShape(value: string): boolean {
  return /^skbc_[A-Za-z0-9_-]{24}$/.test(value);
}

/** The cookie secret a paired kiosk tablet holds. */
export function generateKioskSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** Six digits a manager reads off the office screen and types on the tablet. */
export function generatePairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * A pairing code is six digits, so its hash is salted with the club: the same
 * code live in two clubs hashes differently, and the unique index
 * club_kiosk_devices_live_code_unique is per club anyway.
 */
export function pairingCodeHash(clubId: string, code: string): string {
  return sha256Hex(`kiosk-pairing:${clubId}:${code}`);
}

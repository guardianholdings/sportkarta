import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

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

// ─── The club API (0057) ────────────────────────────────────────────────

/** A recognisable marker, so a leaked key is reported (0015's `skbg_`). */
export const CLUB_API_KEY_PREFIX = 'skbk_';

/** `skbk_` + 32 random bytes as 43 base64url characters. */
export function generateClubApiKey(): string {
  return CLUB_API_KEY_PREFIX + randomBytes(32).toString('base64url');
}

export function isClubApiKeyShape(value: string): boolean {
  return /^skbk_[A-Za-z0-9_-]{43}$/.test(value);
}

/** What the office shows to tell keys apart: the marker and six characters. */
export function clubApiKeyPrefixOf(key: string): string {
  return key.slice(0, CLUB_API_KEY_PREFIX.length + 6);
}

// ─── Door controllers (0057) ────────────────────────────────────────────

export const DOOR_TOKEN_PREFIX = 'skbd_';

/**
 * A door controller's credential: the device id (32 hex, its uuid without
 * dashes) and a 32-byte secret. Like a kiosk's cookie, the id finds the row
 * and the secret's SHA-256 is compared in constant time — secret_hash needs
 * no index.
 */
export function doorToken(deviceId: string, secret: string): string {
  return `${DOOR_TOKEN_PREFIX}${deviceId.replace(/-/g, '')}.${secret}`;
}

export function parseDoorToken(value: string): { deviceId: string; secret: string } | null {
  const match = /^skbd_([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return null;
  const hex = match[1] as string;
  const deviceId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { deviceId, secret: match[2] as string };
}

// ─── Webhook signatures (0057) ──────────────────────────────────────────

/**
 * An endpoint's signing secret, DERIVED rather than stored: HMAC of the
 * endpoint id and its secret_version under CLUB_WEBHOOK_SECRET (which
 * deploy.yml derives from AUTH_SECRET under its own label). Rotating bumps the
 * version; changing CLUB_WEBHOOK_SECRET rotates every endpoint at once, so it
 * must not change casually.
 */
export function webhookSecretFor(master: string, endpointId: string, version: number): string {
  if (master.length < 32) throw new Error('CLUB_WEBHOOK_SECRET is too short');
  const mac = createHmac('sha256', master)
    .update(`pops/club-webhook/${endpointId}/${String(version)}`)
    .digest('base64url');
  return `skbw_${mac}`;
}

function webhookMac(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`)
    .digest('hex');
}

/**
 * The `POPS-Signature` header: `t=<unix seconds>,v1=<hex>` — one v1 per live
 * secret (two for a day after a rotation). The receiver recomputes
 * HMAC-SHA256(secret, "<t>.<raw body>") and compares in constant time.
 */
export function webhookSignatureHeader(
  secrets: readonly string[],
  timestamp: number,
  body: string,
): string {
  return [
    `t=${String(timestamp)}`,
    ...secrets.map((s) => `v1=${webhookMac(s, timestamp, body)}`),
  ].join(',');
}

/**
 * What a receiver does — here so the documentation's recipe is tested.
 * Signature first, then the time, so a forged header learns nothing about the
 * clock (the checkin-token discipline).
 */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  nowSeconds: number,
  toleranceSeconds: number,
): boolean {
  let timestamp: number | null = null;
  const given: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't' && value && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && value && /^[0-9a-f]{64}$/.test(value)) given.push(value);
  }
  if (timestamp === null || given.length === 0) return false;
  const wanted = Buffer.from(webhookMac(secret, timestamp, body), 'hex');
  const matched = given.some((sig) => timingSafeEqual(Buffer.from(sig, 'hex'), wanted));
  return matched && Math.abs(nowSeconds - timestamp) <= toleranceSeconds;
}

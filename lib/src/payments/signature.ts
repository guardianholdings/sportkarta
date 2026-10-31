import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a Stripe webhook's `Stripe-Signature` header — our own code, no SDK
 * (plan 2026-10-25: the club pays through ITS OWN Stripe account; POPS runs
 * no Stripe script and carries no Stripe dependency).
 *
 * The header is `t=<unix seconds>,v1=<hex HMAC-SHA256>[,v1=…]`, signed over
 * `${t}.${rawBody}` with the endpoint's signing secret. The order of checks is
 * the checkin-token discipline: the SIGNATURE first, the TIME second — a
 * forged request learns nothing about our clock, and a replay of a genuine one
 * is refused once it is older than the tolerance.
 *
 * Constant-time comparison; the body must be the RAW bytes as received (a
 * re-serialised JSON object would not verify), which is why the route reads
 * `request.text()`.
 */

export const STRIPE_SIGNATURE_TOLERANCE_S = 300;

export type SignatureVerdict =
  { ok: true; timestamp: number } | { ok: false; reason: 'malformed' | 'mismatch' | 'stale' };

export function stripeSignatureFor(payload: string, timestamp: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${String(timestamp)}.${payload}`)
    .digest('hex');
}

export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = STRIPE_SIGNATURE_TOLERANCE_S,
): SignatureVerdict {
  if (!header || secret === '') return { ok: false, reason: 'malformed' };
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(stripeSignatureFor(rawBody, timestamp, secret), 'hex');
  const matched = signatures.some((signature) => {
    const given = Buffer.from(signature, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matched) return { ok: false, reason: 'mismatch' };
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { ok: false, reason: 'stale' };
  return { ok: true, timestamp };
}

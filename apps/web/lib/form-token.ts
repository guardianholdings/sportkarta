import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { resolveAuthSecret } from './auth-config';

// Tamper-evident timestamp for the min-time-on-form anti-spam check. The token
// is issued server-side when the form renders and verified on submit, so a bot
// cannot simply echo back `Date.now() - 4000` to skip the delay.

/** Faster than a human could read and fill the form: a bot. */
export const MIN_FORM_MS = 3_000;
/** Older than this, the token is treated as stale or replayed. */
export const MAX_FORM_MS = 2 * 60 * 60 * 1000;

/**
 * THE SIGNING KEY IS DERIVED FROM AUTH_SECRET, so it survives restarts.
 *
 * It used to be `randomBytes(32)` per process, on the theory that a form issued
 * before a restart "just fails and the user resubmits". The user could not:
 * the failure was reported as "submitted too fast, try again", the page kept
 * resending the same dead token, and every deploy (a restart on every push to
 * main) turned each open «report a problem» form into a loop that could never
 * succeed. A key derived from the deployment's existing secret is the same on
 * every boot and every module instance, and needs no new configuration.
 *
 * Derived, never the raw secret: a separate key for a separate purpose, in the
 * same way deploy.yml derives the check-in secret (HMAC of AUTH_SECRET under a
 * label). `resolveAuthSecret` already refuses the published placeholders in
 * production; with no usable secret there (sign-in is down anyway) this falls
 * back to the old per-process key rather than signing with something public.
 */
const KEY_LABEL = 'pops/form-token/v1';

// Pinned to globalThis so it is shared across module instances: Next evaluates
// server components (which issue the token) and server actions (which verify it)
// in separate module graphs, so a plain module-level constant would give each a
// different fallback key and every token would fail to verify.
const globalForToken = globalThis as unknown as { __reportFormSecret?: Buffer };

let derived: { secret: string; key: Buffer } | null = null;

function signingKey(): Buffer {
  const secret = resolveAuthSecret(process.env);
  if (!secret) return (globalForToken.__reportFormSecret ??= randomBytes(32));
  if (derived?.secret !== secret) {
    derived = { secret, key: createHmac('sha256', secret).update(KEY_LABEL).digest() };
  }
  return derived.key;
}

function sign(payload: string): string {
  return createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

/** `"<issuedAtMs>.<sig>"` for a hidden form field. */
export function issueFormToken(now: number = Date.now()): string {
  const ts = String(now);
  return `${ts}.${sign(ts)}`;
}

/** Return the issued-at ms if the signature verifies, else null. */
export function verifyFormToken(token: string | null | undefined): number | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const ts = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(ts));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  const n = Number(ts);
  return Number.isFinite(n) ? n : null;
}

/**
 * The verdict on a submitted token, with the two failures a human can hit kept
 * apart from each other.
 *
 * - 'tooFast': genuine token, submitted within MIN_FORM_MS. Retrying with the
 *   SAME token a moment later works.
 * - 'stale': older than MAX_FORM_MS, or not signed by the current key (a key
 *   rotation, or a forgery — the two are deliberately indistinguishable to the
 *   caller). Retrying with the same token can never work, so the caller must
 *   hand out a fresh one and say so, rather than "too fast, try again".
 */
export type FormTokenVerdict =
  { ok: true; issuedAt: number } | { ok: false; reason: 'tooFast' | 'stale' };

export function checkFormToken(
  token: string | null | undefined,
  now: number = Date.now(),
): FormTokenVerdict {
  const issuedAt = verifyFormToken(token);
  if (issuedAt === null) return { ok: false, reason: 'stale' };
  const elapsed = now - issuedAt;
  if (elapsed > MAX_FORM_MS) return { ok: false, reason: 'stale' };
  // Negative elapsed can only be our own clock stepping back a little; the same
  // token will pass once it catches up, which is what 'tooFast' tells the caller.
  if (elapsed < MIN_FORM_MS) return { ok: false, reason: 'tooFast' };
  return { ok: true, issuedAt };
}

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Tamper-evident timestamp for the min-time-on-form anti-spam check. The token
// is issued server-side when the form renders and verified on submit, so a bot
// cannot simply echo back `Date.now() - 4000` to skip the delay.
//
// The signing key is a per-process ephemeral secret (new on each boot): no env
// config, and forms issued before a restart just fail verification and the user
// resubmits — acceptable for an anti-spam heuristic.
//
// Pinned to globalThis so it is shared across module instances: Next evaluates
// server components (which issue the token) and server actions (which verify it)
// in separate module graphs, so a plain module-level constant would give each a
// different secret and every token would fail to verify.
const globalForToken = globalThis as unknown as { __reportFormSecret?: Buffer };
const SECRET = (globalForToken.__reportFormSecret ??= randomBytes(32));

function sign(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('base64url');
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

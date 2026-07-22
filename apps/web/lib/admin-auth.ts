/**
 * TODO(stage-3): replace with better-auth (email OTP + roles). Temporary
 * Stage 1 allowlist: ADMIN_TOKENS env holds comma-separated `name:token`
 * pairs; the name becomes the `actor` on every audit row so edits stay
 * attributable per person even under shared-secret auth.
 *
 * Pure-JS (no node:crypto) so the same module works in middleware and in
 * server actions/components. Every layer re-verifies independently:
 * middleware (redirect), admin layout (render gate), each server action
 * (actor derivation) — never trust a single gate.
 */

export const ADMIN_COOKIE = 'sk_admin';

export interface AdminIdentity {
  actor: string;
}

// The e2e token is public (committed in ci.yml) — it must never grant
// access in production, even if copy-pasted into the VPS environment.
const TEST_ONLY_TOKENS = new Set(['e2e-local-token-1234']);

function parseAdminTokens(): Map<string, string> {
  const raw = process.env.ADMIN_TOKENS ?? '';
  const map = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0 || idx === trimmed.length - 1) continue;
    const name = trimmed.slice(0, idx).trim();
    const token = trimmed.slice(idx + 1).trim();
    if (process.env.NODE_ENV === 'production' && TEST_ONLY_TOKENS.has(token)) continue;
    // Require non-trivial secrets even in the temporary scheme.
    if (name && token.length >= 12) map.set(token, name);
  }
  return map;
}

/** Constant-time string comparison (length-safe, runtime-agnostic). */
function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/** null = not authenticated. Never log the token (no secrets in logs). */
export function verifyAdminToken(token: string | undefined | null): AdminIdentity | null {
  if (!token) return null;
  let matched: AdminIdentity | null = null;
  // Compare against every configured token — no early exit on mismatch.
  for (const [candidate, actor] of parseAdminTokens()) {
    if (constantTimeEqual(candidate, token)) matched = { actor };
  }
  return matched;
}

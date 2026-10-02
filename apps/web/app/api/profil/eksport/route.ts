import { getDb } from '@sportkarta/db';

import {
  accountExportFilename,
  accountExportResponse,
  buildAccountExport,
} from '@/lib/account-export';
import { requireUser } from '@/lib/auth-session';
import { SlidingWindowRateLimiter } from '@/lib/rate-limit';

/**
 * A member downloads their own record as JSON (GDPR Art. 15 access, Art. 20
 * portability) — the same document the operator can produce for them from
 * /admin/akaunti, built by the same function (lib/account-export.ts).
 *
 * THE SESSION IS THE WHOLE AUTHORIZATION, and there is no id in the URL to get
 * wrong: the subject is `requireUser().id`, so this route can only ever return
 * the caller's own account. /api is outside the middleware matcher, so
 * requireUser() is also the only sign-in gate — it sends a signed-out visitor
 * to /vhod, and a suspended account (0033) counts as signed out.
 *
 * No access-log row: the log records admins reading other people's data, and a
 * member reading their own is neither.
 *
 * Throttled per ACCOUNT (never per IP — nothing about the request is kept): a
 * full export is two dozen statements, and a reload loop should not be able to
 * turn a legal right into load on a small VPS.
 */

export const dynamic = 'force-dynamic';

const EXPORTS_PER_WINDOW = 5;
const WINDOW_MS = 10 * 60 * 1000;

// Pinned to globalThis for the same reason as lib/form-token.ts: Next may
// evaluate this module more than once, and each copy would count separately.
const globalForExport = globalThis as unknown as {
  __accountExportLimiter?: SlidingWindowRateLimiter;
};
const limiter = (globalForExport.__accountExportLimiter ??= new SlidingWindowRateLimiter(
  EXPORTS_PER_WINDOW,
  WINDOW_MS,
));

export async function GET() {
  const user = await requireUser();

  const verdict = limiter.check(user.id);
  if (!verdict.allowed) {
    return new Response(null, {
      status: 429,
      headers: { 'Retry-After': String(Math.ceil(verdict.retryAfterMs / 1000)) },
    });
  }

  const now = new Date();
  const data = await buildAccountExport(getDb(), user.id, now);
  // The row vanished between the session check and the read (erased in
  // another tab): nothing to export, and nothing to say about whom.
  if (!data) return new Response(null, { status: 404 });

  return accountExportResponse(data, accountExportFilename(now));
}

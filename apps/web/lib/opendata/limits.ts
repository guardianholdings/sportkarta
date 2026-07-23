import { clientIpFromForwardedFor, SlidingWindowRateLimiter } from '@/lib/rate-limit';

/**
 * SOFT limits for the open-data API (Stage 6.1).
 *
 * "Soft" is not a synonym for "high". It is four specific properties, and each
 * one is a decision about what happens to somebody who is not attacking us —
 * which, on a public data API, is almost everybody who ever hits a limit:
 *
 *   1. EVERY response carries RateLimit-Limit / -Remaining / -Reset, not just
 *      the ones that fail. A client that can see its budget can slow down on
 *      its own; a client that only learns about the limit by being refused
 *      learns about it in production, at the worst moment, from an exception.
 *   2. Over quota is 429 with Retry-After and a body that names the bulk dump.
 *      It is never a ban, never an automatic revocation, and never a 403 — the
 *      caller is being asked to wait, not told they are unwelcome, and the
 *      response says which door to use instead.
 *   3. THE DUMPS ARE NOT RATE-LIMITED AT ALL. The right answer to "you are
 *      making 4 000 requests an hour" is not to refuse the 4 001st; it is to
 *      hand over the whole dataset in one file. Throttling the download while
 *      throttling the API would leave a determined consumer no legal path at
 *      all, which is how a public dataset ends up being scraped through a
 *      rotating proxy.
 *   4. IT FAILS OPEN. Any error inside the limiter serves the request. An
 *      open-data API that goes dark because a counter threw is worse than one
 *      that serves too much for a minute, and the data is public anyway — the
 *      limit protects one VPS's CPU, not a secret.
 *
 * IN-MEMORY AND PER-PROCESS, deliberately. Migration 0015 explains the whole
 * argument: a persistent counter means a persistent record of who asked for
 * what, which on this API would be a more sensitive table than anything it
 * protects. The IP key lives in this Map's timestamps and is never written
 * down, exactly as the anonymous report limiter has always worked.
 */

/** Anonymous callers, per client IP. Enough for a page of a dashboard. */
const ANON_PER_MINUTE = Number(process.env.OPENDATA_RATE_LIMIT_ANON ?? 30);

/** With a key, per key. Enough for a nightly sync somebody wrote in a hurry. */
const KEYED_PER_MINUTE = Number(process.env.OPENDATA_RATE_LIMIT_KEYED ?? 300);

const WINDOW_MS = 60_000;

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const anonLimit = positiveOr(ANON_PER_MINUTE, 30);
const keyedLimit = positiveOr(KEYED_PER_MINUTE, 300);

// Two limiters rather than one keyed map: the budgets differ, and a single
// limiter would have to carry the limit per key, which is how the anonymous
// budget accidentally becomes the keyed one.
const anonLimiter = new SlidingWindowRateLimiter(anonLimit, WINDOW_MS);
const keyedLimiter = new SlidingWindowRateLimiter(keyedLimit, WINDOW_MS);

export interface LimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window frees up. 0 while allowed. */
  retryAfterSeconds: number;
}

const ALLOW_ON_ERROR = (limit: number): LimitDecision => ({
  allowed: true,
  limit,
  remaining: limit,
  retryAfterSeconds: 0,
});

/**
 * Charge one request against the caller's budget.
 *
 * `keyId` is the api_keys row id when the request presented a valid key, and
 * null otherwise. An anonymous caller with no resolvable IP (no proxy header at
 * all, which on this deployment means something is misconfigured rather than
 * malicious) is not limited — see fail-open above.
 */
export function chargeOpenDataRequest(
  keyId: string | null,
  forwardedFor: string | null,
): LimitDecision {
  const limit = keyId ? keyedLimit : anonLimit;
  try {
    const identity = keyId ?? clientIpFromForwardedFor(forwardedFor);
    if (!identity) return ALLOW_ON_ERROR(limit);

    const limiter = keyId ? keyedLimiter : anonLimiter;
    const result = limiter.check(identity);
    return {
      allowed: result.allowed,
      limit,
      // The limiter reports allow/deny rather than a count, so "remaining" is
      // the honest binary it can actually support: headroom, or none. A number
      // invented here would be a number clients would then depend on.
      remaining: result.allowed ? Math.max(limit - 1, 0) : 0,
      retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000),
    };
  } catch {
    return ALLOW_ON_ERROR(limit);
  }
}

export function rateLimitHeaders(decision: LimitDecision): Record<string, string> {
  return {
    'RateLimit-Limit': String(decision.limit),
    'RateLimit-Remaining': String(decision.remaining),
    'RateLimit-Reset': String(decision.retryAfterSeconds || Math.ceil(WINDOW_MS / 1000)),
  };
}

export const OPEN_DATA_LIMITS = {
  anonPerMinute: anonLimit,
  keyedPerMinute: keyedLimit,
  windowSeconds: WINDOW_MS / 1000,
} as const;

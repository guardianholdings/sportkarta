import { SlidingWindowRateLimiter } from './rate-limit';

/**
 * Sign-in limiters, held per process like the report limiter (single-container
 * deployment: one web process, so an in-memory Map is the whole picture; a
 * restart forgets it, which is an acceptable trade for anti-abuse heuristics).
 *
 * The sign-in server action is the ONLY way to request or redeem a code: every
 * better-auth REST endpoint that could do either is disabled (lib/auth-surface.ts),
 * and better-auth's own limiter never sees in-process `auth.api.*` calls anyway.
 * So these are the throttles, and each is keyed on purpose:
 *
 *  Sending a code (10-minute window):
 *  - by IP, so one host cannot spray codes at many addresses;
 *  - by email, so an address cannot be mail-bombed from many hosts;
 *  - one GLOBAL hourly cap, so a flood from many hosts at many addresses cannot
 *    burn the SMTP relay's quota and sender reputation — the thing every other
 *    member's sign-in depends on.
 *
 *  Redeeming a code (one-hour window, FAILED attempts only):
 *  - by email, which is what bounds brute force. better-auth allows 3 guesses
 *    per code, but every newly sent code starts that count again, so without
 *    this a patient attacker gets 3 guesses per code, indefinitely;
 *  - by IP, so one host cannot guess at many accounts at once.
 *  A correct code gives its slot back, so members who sign in are never counted.
 *
 * All caps are environment-tunable: they are anti-abuse heuristics, and an
 * office or school behind one NAT address is a realistic false positive. The
 * e2e suite raises the IP caps for the same reason — every browser in it shares
 * one IP. The per-email verify cap is also a lockout lever (ten wrong codes
 * block an address for up to an hour), which is the standard price of bounding
 * guesses per account.
 */
const SEND_WINDOW_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const DEFAULT_SEND_IP_LIMIT = 10;
const DEFAULT_SEND_EMAIL_LIMIT = 5;
/**
 * Well above any organic peak for a national volunteer map (about three new
 * sign-ins a minute, sustained for an hour), and low enough that a distributed
 * flood cannot turn the site into a spam cannon.
 */
const DEFAULT_SEND_GLOBAL_PER_HOUR = 200;
const DEFAULT_VERIFY_EMAIL_FAILURES = 10;
const DEFAULT_VERIFY_IP_FAILURES = 30;

function limitFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const globalForRl = globalThis as unknown as {
  __otpIpRateLimiter?: SlidingWindowRateLimiter;
  __otpEmailRateLimiter?: SlidingWindowRateLimiter;
  __otpGlobalSendLimiter?: SlidingWindowRateLimiter;
  __otpVerifyEmailLimiter?: SlidingWindowRateLimiter;
  __otpVerifyIpLimiter?: SlidingWindowRateLimiter;
};

export const otpIpRateLimiter =
  globalForRl.__otpIpRateLimiter ??
  (globalForRl.__otpIpRateLimiter = new SlidingWindowRateLimiter(
    limitFromEnv('OTP_RATE_LIMIT_IP', DEFAULT_SEND_IP_LIMIT),
    SEND_WINDOW_MS,
  ));

export const otpEmailRateLimiter =
  globalForRl.__otpEmailRateLimiter ??
  (globalForRl.__otpEmailRateLimiter = new SlidingWindowRateLimiter(
    limitFromEnv('OTP_RATE_LIMIT_EMAIL', DEFAULT_SEND_EMAIL_LIMIT),
    SEND_WINDOW_MS,
  ));

/** One key for the whole process: this is a circuit breaker, not a per-client limit. */
export const GLOBAL_SEND_KEY = 'all';

export const otpGlobalSendLimiter =
  globalForRl.__otpGlobalSendLimiter ??
  (globalForRl.__otpGlobalSendLimiter = new SlidingWindowRateLimiter(
    limitFromEnv('OTP_SEND_LIMIT_PER_HOUR', DEFAULT_SEND_GLOBAL_PER_HOUR),
    HOUR_MS,
  ));

export const otpVerifyEmailLimiter =
  globalForRl.__otpVerifyEmailLimiter ??
  (globalForRl.__otpVerifyEmailLimiter = new SlidingWindowRateLimiter(
    limitFromEnv('OTP_VERIFY_LIMIT_EMAIL', DEFAULT_VERIFY_EMAIL_FAILURES),
    HOUR_MS,
  ));

export const otpVerifyIpLimiter =
  globalForRl.__otpVerifyIpLimiter ??
  (globalForRl.__otpVerifyIpLimiter = new SlidingWindowRateLimiter(
    limitFromEnv('OTP_VERIFY_LIMIT_IP', DEFAULT_VERIFY_IP_FAILURES),
    HOUR_MS,
  ));

export interface CodeAttempt {
  /** The code was right: give both slots back, so a success is never counted. */
  succeeded(): void;
}

/**
 * Take a slot on both failure limiters BEFORE the code is checked, or null when
 * either is spent. Counting up front (and refunding on success) rather than
 * recording after a failure closes the race where a burst of parallel guesses
 * all pass a check that only sees completed failures.
 */
export function beginCodeAttempt(
  email: string,
  ip: string,
  limiters: { email: SlidingWindowRateLimiter; ip: SlidingWindowRateLimiter } = {
    email: otpVerifyEmailLimiter,
    ip: otpVerifyIpLimiter,
  },
): CodeAttempt | null {
  if (!limiters.email.check(email).allowed) return null;
  if (!limiters.ip.check(ip).allowed) {
    limiters.email.release(email);
    return null;
  }
  return {
    succeeded() {
      limiters.email.release(email);
      limiters.ip.release(ip);
    },
  };
}

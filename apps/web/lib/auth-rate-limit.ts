import { SlidingWindowRateLimiter } from './rate-limit';

/**
 * Sign-in limiters, held per process like the report limiter (single-container
 * deployment). better-auth's own limiter guards /api/auth/* (see the rateLimit
 * options in lib/auth.ts — it must stay on, or direct API calls bypass every
 * throttle here); these sit in front of the server actions and are keyed
 * differently on purpose:
 *
 *  - by IP, so one host cannot spray codes at many addresses;
 *  - by email, so an address cannot be mail-bombed from many hosts.
 *
 * Both caps are environment-tunable: they are anti-abuse heuristics, not
 * security boundaries (OTP entropy and the 3-attempt limit are), and an office
 * or school behind one NAT address is a realistic false positive. The e2e suite
 * raises the IP cap for the same reason — every browser in it shares one IP.
 */
const WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_IP_LIMIT = 10;
const DEFAULT_EMAIL_LIMIT = 5;

function limitFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const globalForRl = globalThis as unknown as {
  __otpIpRateLimiter?: SlidingWindowRateLimiter;
  __otpEmailRateLimiter?: SlidingWindowRateLimiter;
};

export const otpIpRateLimiter =
  globalForRl.__otpIpRateLimiter ??
  (globalForRl.__otpIpRateLimiter = new SlidingWindowRateLimiter(
    limitFromEnv('OTP_RATE_LIMIT_IP', DEFAULT_IP_LIMIT),
    WINDOW_MS,
  ));

export const otpEmailRateLimiter =
  globalForRl.__otpEmailRateLimiter ??
  (globalForRl.__otpEmailRateLimiter = new SlidingWindowRateLimiter(
    limitFromEnv('OTP_RATE_LIMIT_EMAIL', DEFAULT_EMAIL_LIMIT),
    WINDOW_MS,
  ));

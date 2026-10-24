import { SlidingWindowRateLimiter } from '@/lib/rate-limit';

/**
 * The club module's throttles, per process like every other limiter here
 * (single web container; a restart forgets them, acceptable for anti-abuse).
 *
 *  - Kiosk pairing: a 6-digit code lives 10 minutes, so FAILED attempts are
 *    capped per club and per IP. 20 failures per club per 10 minutes leaves an
 *    attacker a 1-in-50,000 chance per code; a correct code gives its slot
 *    back, so a desk that mistypes once is never counted.
 *  - Claims, invites and kiosk redemptions by a signed-in member: per account,
 *    generous for people, tight for scripts.
 *
 * Keys are a club id, an account id or the transient client IP — never
 * persisted, never logged.
 */
const TEN_MINUTES = 10 * 60 * 1000;

const globalForRl = globalThis as unknown as {
  __kioskPairClubLimiter?: SlidingWindowRateLimiter;
  __kioskPairIpLimiter?: SlidingWindowRateLimiter;
  __clubMemberActionLimiter?: SlidingWindowRateLimiter;
};

export const kioskPairClubLimiter =
  globalForRl.__kioskPairClubLimiter ??
  (globalForRl.__kioskPairClubLimiter = new SlidingWindowRateLimiter(20, TEN_MINUTES));

export const kioskPairIpLimiter =
  globalForRl.__kioskPairIpLimiter ??
  (globalForRl.__kioskPairIpLimiter = new SlidingWindowRateLimiter(30, TEN_MINUTES));

export const clubMemberActionLimiter =
  globalForRl.__clubMemberActionLimiter ??
  (globalForRl.__clubMemberActionLimiter = new SlidingWindowRateLimiter(30, TEN_MINUTES));

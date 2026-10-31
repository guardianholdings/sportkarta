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
const ONE_MINUTE = 60 * 1000;

/**
 * The club API (0057): per key a minute's budget generous for a sync job,
 * per door controller enough for a queue at the turnstile, and per client IP
 * a cap on FAILED authentications — keys are 256 bits, so this is about
 * garbage floods, not guessing.
 */
export const CLUB_API_PER_MINUTE = 120;
export const CLUB_DOOR_PER_MINUTE = 60;

const globalForRl = globalThis as unknown as {
  __kioskPairClubLimiter?: SlidingWindowRateLimiter;
  __kioskPairIpLimiter?: SlidingWindowRateLimiter;
  __clubMemberActionLimiter?: SlidingWindowRateLimiter;
  __clubApiKeyLimiter?: SlidingWindowRateLimiter;
  __clubApiFailureLimiter?: SlidingWindowRateLimiter;
  __clubDoorLimiter?: SlidingWindowRateLimiter;
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

export const clubApiKeyLimiter =
  globalForRl.__clubApiKeyLimiter ??
  (globalForRl.__clubApiKeyLimiter = new SlidingWindowRateLimiter(CLUB_API_PER_MINUTE, ONE_MINUTE));

export const clubApiFailureLimiter =
  globalForRl.__clubApiFailureLimiter ??
  (globalForRl.__clubApiFailureLimiter = new SlidingWindowRateLimiter(30, TEN_MINUTES));

export const clubDoorLimiter =
  globalForRl.__clubDoorLimiter ??
  (globalForRl.__clubDoorLimiter = new SlidingWindowRateLimiter(CLUB_DOOR_PER_MINUTE, ONE_MINUTE));

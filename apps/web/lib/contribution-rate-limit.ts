import { SlidingWindowRateLimiter } from './rate-limit';

/**
 * Per-account limits on contributions. Keyed by user id, not IP: these flows
 * require an account, so the account is the meaningful unit of abuse — and it
 * survives a phone hopping between networks.
 *
 * Generous enough for a genuine mapping session (an ambassador walking a
 * neighbourhood), tight enough that a script cannot flood the national dataset
 * before a moderator notices.
 */
const WINDOW_MS = 60 * 60 * 1000;

const globalForRl = globalThis as unknown as {
  __addFacilityRateLimiter?: SlidingWindowRateLimiter;
  __contributionRateLimiter?: SlidingWindowRateLimiter;
};

/** New facilities: each one needs a photo and moderation, so keep it modest. */
export const addFacilityRateLimiter =
  globalForRl.__addFacilityRateLimiter ??
  (globalForRl.__addFacilityRateLimiter = new SlidingWindowRateLimiter(20, WINDOW_MS));

/** Verifications and condition reports: cheap, repeatable, still bounded. */
export const contributionRateLimiter =
  globalForRl.__contributionRateLimiter ??
  (globalForRl.__contributionRateLimiter = new SlidingWindowRateLimiter(60, WINDOW_MS));

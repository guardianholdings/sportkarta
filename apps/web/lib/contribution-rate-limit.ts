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
  __rosterRateLimiter?: SlidingWindowRateLimiter;
  __trainingRateLimiter?: SlidingWindowRateLimiter;
};

/** New facilities: each one needs a photo and moderation, so keep it modest. */
export const addFacilityRateLimiter =
  globalForRl.__addFacilityRateLimiter ??
  (globalForRl.__addFacilityRateLimiter = new SlidingWindowRateLimiter(20, WINDOW_MS));

/** Verifications and condition reports: cheap, repeatable, still bounded. */
export const contributionRateLimiter =
  globalForRl.__contributionRateLimiter ??
  (globalForRl.__contributionRateLimiter = new SlidingWindowRateLimiter(60, WINDOW_MS));

/**
 * Organiser check-ins from the roster deck. Its own budget rather than the
 * contribution one: an organiser ticking off a full session of forty people
 * must not find themselves unable to verify a facility afterwards, and forty
 * is nowhere near what a script needs to hurt anything. Each tick is a
 * database transaction, so it is bounded all the same.
 */
export const rosterRateLimiter =
  globalForRl.__rosterRateLimiter ??
  (globalForRl.__rosterRateLimiter = new SlidingWindowRateLimiter(200, WINDOW_MS));

/**
 * Logged trainings. Earns nothing (operator decision 2026-07-26), so the only
 * reason to script it is to grow the database — a member back-filling a busy
 * week fits comfortably inside thirty an hour.
 */
export const trainingRateLimiter =
  globalForRl.__trainingRateLimiter ??
  (globalForRl.__trainingRateLimiter = new SlidingWindowRateLimiter(30, WINDOW_MS));

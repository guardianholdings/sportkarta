import { SlidingWindowRateLimiter } from './rate-limit';

// Process-wide limiter for anonymous report submissions: at most 5 per IP per
// 10 minutes. Cached on globalThis so it survives dev HMR (in production the
// standalone server keeps one instance per process).
const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 5;

const globalForRl = globalThis as unknown as { __reportRateLimiter?: SlidingWindowRateLimiter };

export const reportRateLimiter =
  globalForRl.__reportRateLimiter ??
  (globalForRl.__reportRateLimiter = new SlidingWindowRateLimiter(LIMIT, WINDOW_MS));

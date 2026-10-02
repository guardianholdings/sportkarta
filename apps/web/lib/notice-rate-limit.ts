import { SlidingWindowRateLimiter } from './rate-limit';

// Process-wide limiter for the public notice form (/signal): at most 5 per IP
// per 10 minutes, the facility report form's budget. Its own instance, so a
// burst of problem reports cannot lock somebody out of reporting illegal
// content, or the other way round. Cached on globalThis so it survives dev HMR.
const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 5;

const globalForRl = globalThis as unknown as { __noticeRateLimiter?: SlidingWindowRateLimiter };

export const noticeRateLimiter =
  globalForRl.__noticeRateLimiter ??
  (globalForRl.__noticeRateLimiter = new SlidingWindowRateLimiter(LIMIT, WINDOW_MS));

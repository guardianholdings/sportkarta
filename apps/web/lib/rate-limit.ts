// In-memory sliding-window rate limiter for the anonymous report endpoint
// (docs/ROADMAP.md 2.2 — anti-spam without a captcha). Single-VPS deployment,
// so a per-process Map is sufficient; it resets on restart, which is an
// acceptable trade for a spam heuristic. The key is the transient client IP —
// it lives only in this Map's timestamps and is never persisted.

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the next request would be allowed (0 when allowed). */
  retryAfterMs: number;
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private checksSincePrune = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): RateLimitResult {
    const t = this.now();
    const windowStart = t - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((ts) => ts > windowStart);

    this.maybePrune(t);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? t;
      return { allowed: false, retryAfterMs: Math.max(0, oldest + this.windowMs - t) };
    }

    recent.push(t);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Drop keys whose hits have all aged out — bounds memory under many IPs. */
  private maybePrune(t: number): void {
    if (++this.checksSincePrune < 1000) return;
    this.checksSincePrune = 0;
    const windowStart = t - this.windowMs;
    for (const [key, times] of this.hits) {
      if (!times.some((ts) => ts > windowStart)) this.hits.delete(key);
    }
  }
}

/**
 * Client IP for rate-limiting, from `X-Forwarded-For`.
 *
 * Take the RIGHTMOST hop, not the leftmost. The app is only reachable through
 * Caddy (deploy/Caddyfile; web:3000 is not published), and Caddy APPENDS the
 * real TCP peer as the last XFF entry. A client can prepend spoofed entries
 * (`X-Forwarded-For: 1.1.1.1, ...`) but cannot forge the one Caddy adds, so the
 * rightmost value is the trustworthy per-client key. Returns null when absent.
 */
export function clientIpFromForwardedFor(xff: string | null | undefined): string | null {
  if (!xff) return null;
  const hops = xff
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return hops.length > 0 ? (hops[hops.length - 1] as string) : null;
}

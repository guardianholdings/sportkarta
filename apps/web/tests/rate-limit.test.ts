import { describe, expect, it } from 'vitest';

import { clientIpFromForwardedFor, SlidingWindowRateLimiter } from '../lib/rate-limit';

// A controllable clock so the sliding window is deterministic (no real time).
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('SlidingWindowRateLimiter', () => {
  it('allows up to the limit, then blocks', () => {
    const clock = fakeClock();
    const rl = new SlidingWindowRateLimiter(3, 10_000, clock.now);

    expect(rl.check('ip').allowed).toBe(true);
    expect(rl.check('ip').allowed).toBe(true);
    expect(rl.check('ip').allowed).toBe(true);
    const blocked = rl.check('ip');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('tracks keys independently', () => {
    const clock = fakeClock();
    const rl = new SlidingWindowRateLimiter(1, 10_000, clock.now);
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(false);
    // A different IP is unaffected.
    expect(rl.check('b').allowed).toBe(true);
  });

  it('allows again once the oldest hit slides out of the window', () => {
    const clock = fakeClock();
    const rl = new SlidingWindowRateLimiter(2, 10_000, clock.now);

    expect(rl.check('ip').allowed).toBe(true); // t=0
    clock.advance(4_000);
    expect(rl.check('ip').allowed).toBe(true); // t=4000
    expect(rl.check('ip').allowed).toBe(false); // still 2 in window

    // Advance past the first hit's window (t=0 hit expires at 10_000).
    clock.advance(6_100); // t=10_100 — first hit gone, second (t=4000) remains
    expect(rl.check('ip').allowed).toBe(true);
    // Now two in window again (t=4000, t=10_100).
    expect(rl.check('ip').allowed).toBe(false);
  });

  it('reports a shrinking retryAfter as the window advances', () => {
    const clock = fakeClock();
    const rl = new SlidingWindowRateLimiter(1, 10_000, clock.now);
    rl.check('ip');
    const a = rl.check('ip').retryAfterMs;
    clock.advance(3_000);
    const b = rl.check('ip').retryAfterMs;
    expect(a).toBe(10_000);
    expect(b).toBe(7_000);
  });
});

describe('clientIpFromForwardedFor', () => {
  it('takes the RIGHTMOST hop (the one Caddy appends), not the spoofable left', () => {
    // A client prepends fakes; Caddy appends the real peer last.
    expect(clientIpFromForwardedFor('1.1.1.1, 2.2.2.2, 203.0.113.7')).toBe('203.0.113.7');
  });
  it('trims and handles a single value', () => {
    expect(clientIpFromForwardedFor('  198.51.100.9 ')).toBe('198.51.100.9');
  });
  it('ignores trailing empty hops', () => {
    expect(clientIpFromForwardedFor('203.0.113.7, ')).toBe('203.0.113.7');
  });
  it('returns null when absent or blank', () => {
    expect(clientIpFromForwardedFor(null)).toBeNull();
    expect(clientIpFromForwardedFor(undefined)).toBeNull();
    expect(clientIpFromForwardedFor('')).toBeNull();
    expect(clientIpFromForwardedFor('  ')).toBeNull();
  });
});

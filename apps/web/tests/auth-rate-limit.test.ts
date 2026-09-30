import { describe, expect, it } from 'vitest';

import { beginCodeAttempt } from '@/lib/auth-rate-limit';
import { SlidingWindowRateLimiter } from '@/lib/rate-limit';

const HOUR = 60 * 60 * 1000;

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function limiters(emailLimit: number, ipLimit: number, now: () => number) {
  return {
    email: new SlidingWindowRateLimiter(emailLimit, HOUR, now),
    ip: new SlidingWindowRateLimiter(ipLimit, HOUR, now),
  };
}

describe('SlidingWindowRateLimiter.release', () => {
  it('hands back the most recent hit', () => {
    const rl = new SlidingWindowRateLimiter(1, HOUR, fakeClock().now);
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(false);
    rl.release('a');
    expect(rl.check('a').allowed).toBe(true);
  });

  it('is a no-op for a key with nothing to release', () => {
    const rl = new SlidingWindowRateLimiter(1, HOUR, fakeClock().now);
    rl.release('never-seen');
    expect(rl.check('never-seen').allowed).toBe(true);
  });
});

describe('beginCodeAttempt', () => {
  it('caps wrong codes per address, however many fresh codes are sent', () => {
    // better-auth resets its 3-guess count with every new code; this cap does
    // not know or care about codes, only failures per address.
    const clock = fakeClock();
    const l = limiters(3, 100, clock.now);
    for (let i = 0; i < 3; i += 1) {
      expect(beginCodeAttempt('victim@example.org', `10.0.0.${String(i)}`, l)).not.toBeNull();
    }
    // A fourth guess from a fourth host is still refused: the address is spent.
    expect(beginCodeAttempt('victim@example.org', '10.0.0.9', l)).toBeNull();
    // Another address is unaffected.
    expect(beginCodeAttempt('other@example.org', '10.0.0.9', l)).not.toBeNull();
  });

  it('caps wrong codes per IP across addresses', () => {
    const l = limiters(100, 2, fakeClock().now);
    expect(beginCodeAttempt('a@example.org', '1.2.3.4', l)).not.toBeNull();
    expect(beginCodeAttempt('b@example.org', '1.2.3.4', l)).not.toBeNull();
    expect(beginCodeAttempt('c@example.org', '1.2.3.4', l)).toBeNull();
    // The refused attempt did not use up c@'s own allowance.
    expect(beginCodeAttempt('c@example.org', '5.6.7.8', l)).not.toBeNull();
  });

  it('does not count a correct code', () => {
    const l = limiters(2, 100, fakeClock().now);
    beginCodeAttempt('m@example.org', 'ip', l)?.succeeded();
    beginCodeAttempt('m@example.org', 'ip', l)?.succeeded();
    beginCodeAttempt('m@example.org', 'ip', l)?.succeeded();
    // Three sign-ins, zero failures: two wrong codes are still allowed.
    expect(beginCodeAttempt('m@example.org', 'ip', l)).not.toBeNull();
    expect(beginCodeAttempt('m@example.org', 'ip', l)).not.toBeNull();
    expect(beginCodeAttempt('m@example.org', 'ip', l)).toBeNull();
  });

  it('counts an attempt while it is still in flight', () => {
    // Parallel guesses must not all pass a check that only sees completed
    // failures: the slot is taken before the code is checked.
    const l = limiters(2, 100, fakeClock().now);
    const inFlight = [
      beginCodeAttempt('p@example.org', 'ip', l),
      beginCodeAttempt('p@example.org', 'ip', l),
      beginCodeAttempt('p@example.org', 'ip', l),
    ];
    expect(inFlight.filter(Boolean)).toHaveLength(2);
  });

  it('forgets failures after an hour', () => {
    const clock = fakeClock();
    const l = limiters(1, 100, clock.now);
    expect(beginCodeAttempt('late@example.org', 'ip', l)).not.toBeNull();
    expect(beginCodeAttempt('late@example.org', 'ip', l)).toBeNull();
    clock.advance(HOUR + 1);
    expect(beginCodeAttempt('late@example.org', 'ip', l)).not.toBeNull();
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  GRACE_WINDOWS,
  issueCheckinToken,
  msUntilNextWindow,
  verifyCheckinToken,
  windowIndexFor,
  WINDOW_MS,
} from './index.js';

const SECRET = 'a-development-check-in-secret-value';
const OTHER_SECRET = 'a-different-check-in-secret-value!!';
const OCCURRENCE = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-07-23T18:00:00Z');

function at(offsetMs: number): Date {
  return new Date(AT.getTime() + offsetMs);
}

describe('issueCheckinToken', () => {
  it('is stable within a window, so the QR does not change under the camera', () => {
    const a = issueCheckinToken({ occurrenceId: OCCURRENCE, secret: SECRET, at: at(0) });
    const b = issueCheckinToken({ occurrenceId: OCCURRENCE, secret: SECRET, at: at(59_000) });
    expect(a).toBe(b);
  });

  it('changes at a window boundary', () => {
    const a = issueCheckinToken({ occurrenceId: OCCURRENCE, secret: SECRET, at: at(0) });
    const b = issueCheckinToken({ occurrenceId: OCCURRENCE, secret: SECRET, at: at(WINDOW_MS) });
    expect(a).not.toBe(b);
  });

  it('is URL-safe, so it drops into a path with no escaping', () => {
    const token = issueCheckinToken({ occurrenceId: OCCURRENCE, secret: SECRET, at: AT });
    expect(token).toMatch(/^[A-Za-z0-9~_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
    // No dot, deliberately: apps/web/middleware.ts skips any path containing
    // one, so a dot-separated token in a path segment would bypass the i18n
    // middleware and 404 on arrival.
    expect(token).not.toContain('.');
  });

  it('names the occurrence and nothing else — no member, no secret', () => {
    const token = issueCheckinToken({ occurrenceId: OCCURRENCE, secret: SECRET, at: AT });
    // The QR is printed once for everybody in the park; who redeems it is
    // decided by the session cookie on the request, never by the token.
    expect(token).toContain(OCCURRENCE);
    expect(token).not.toContain(SECRET);
  });

  it('refuses to issue without a secret rather than signing with an empty one', () => {
    expect(() => issueCheckinToken({ occurrenceId: OCCURRENCE, secret: '', at: AT })).toThrow();
  });
});

describe('verifyCheckinToken', () => {
  const token = issueCheckinToken({ occurrenceId: OCCURRENCE, secret: SECRET, at: AT });

  it('accepts a token in its own window', () => {
    expect(verifyCheckinToken(token, SECRET, at(0))).toEqual({
      ok: true,
      occurrenceId: OCCURRENCE,
      window: windowIndexFor(AT),
    });
  });

  it('accepts the previous window, so a scan starting at 59.9s still works', () => {
    const result = verifyCheckinToken(token, SECRET, at(WINDOW_MS * GRACE_WINDOWS + 500));
    expect(result.ok).toBe(true);
  });

  it('expires beyond the grace window', () => {
    const result = verifyCheckinToken(token, SECRET, at(WINDOW_MS * (GRACE_WINDOWS + 1) + 1));
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a token from the future — that is clock skew, not validity', () => {
    const future = issueCheckinToken({
      occurrenceId: OCCURRENCE,
      secret: SECRET,
      at: at(WINDOW_MS * 10),
    });
    expect(verifyCheckinToken(future, SECRET, at(0))).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a token signed with another secret', () => {
    expect(verifyCheckinToken(token, OTHER_SECRET, at(0))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a token whose occurrence has been swapped', () => {
    // The occurrence is inside the signed payload, so pointing a valid token at
    // a different session invalidates it.
    const other = '22222222-2222-4222-8222-222222222222';
    const forged = token.replace(OCCURRENCE, other);
    expect(verifyCheckinToken(forged, SECRET, at(0))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a token whose window has been pushed forward', () => {
    const parts = token.split('~');
    const forged = [parts[0], parts[1], String(Number(parts[2]) + 5), parts[3]].join('~');
    expect(verifyCheckinToken(forged, SECRET, at(0))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('checks the signature BEFORE the clock, so expiry is not an oracle', () => {
    // A long-expired token with a broken tag must report the signature failure,
    // never "expired" — otherwise the difference tells an attacker their forged
    // tag was correct.
    const old = issueCheckinToken({
      occurrenceId: OCCURRENCE,
      secret: SECRET,
      at: at(-WINDOW_MS * 1000),
    });
    const tampered = `${old.slice(0, -4)}AAAA`;
    expect(verifyCheckinToken(tampered, SECRET, at(0))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('reports malformed input without throwing, for any string at all', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (garbage) => {
        const result = verifyCheckinToken(garbage, SECRET, at(0));
        expect(result.ok).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it('never accepts anything with an empty secret configured', () => {
    // Fail closed: an unset CHECKIN_TOKEN_SECRET must not make every token valid.
    expect(verifyCheckinToken(token, '', at(0)).ok).toBe(false);
  });

  it('round-trips for any occurrence id and any moment', () => {
    fc.assert(
      // Milliseconds since the epoch rather than fc.date(): the token encodes a
      // window index, and a pre-1970 date makes that negative — which the
      // verifier rightly calls malformed, but which is not a session anybody
      // will ever schedule.
      fc.property(fc.uuid(), fc.integer({ min: 0, max: 2_200_000_000_000 }), (id, ms) => {
        const moment = new Date(ms);
        const issued = issueCheckinToken({ occurrenceId: id, secret: SECRET, at: moment });
        const result = verifyCheckinToken(issued, SECRET, moment);
        expect(result).toMatchObject({ ok: true, occurrenceId: id });
      }),
      { numRuns: 200 },
    );
  });
});

describe('msUntilNextWindow', () => {
  it('counts down to the boundary', () => {
    expect(msUntilNextWindow(new Date(WINDOW_MS * 5))).toBe(WINDOW_MS);
    expect(msUntilNextWindow(new Date(WINDOW_MS * 5 + 40_000))).toBe(20_000);
  });

  it('never returns less than a second, so a refresh cannot spin', () => {
    expect(msUntilNextWindow(new Date(WINDOW_MS * 6 - 1))).toBe(1000);
  });
});

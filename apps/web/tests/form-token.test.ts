import { describe, expect, it } from 'vitest';

import { issueFormToken, verifyFormToken } from '../lib/form-token';

// The signed form token backs the min-time-on-form anti-spam check: a bot must
// not be able to forge or tamper with the issued-at timestamp.
describe('form-token', () => {
  it('round-trips the issued-at time through a valid token', () => {
    const now = 1_700_000_000_000;
    expect(verifyFormToken(issueFormToken(now))).toBe(now);
  });

  it('rejects a tampered timestamp (kept signature)', () => {
    const token = issueFormToken(1_700_000_000_000);
    const sig = token.slice(token.indexOf('.') + 1);
    // Attacker rewrites the timestamp to "just now" but can't re-sign it.
    expect(verifyFormToken(`1699999999000.${sig}`)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const token = issueFormToken(1_700_000_000_000);
    const ts = token.slice(0, token.indexOf('.'));
    expect(verifyFormToken(`${ts}.not-a-real-signature`)).toBeNull();
  });

  it('rejects malformed / empty / null input', () => {
    expect(verifyFormToken('')).toBeNull();
    expect(verifyFormToken(null)).toBeNull();
    expect(verifyFormToken(undefined)).toBeNull();
    expect(verifyFormToken('no-dot-here')).toBeNull();
    expect(verifyFormToken('.onlysig')).toBeNull();
  });
});

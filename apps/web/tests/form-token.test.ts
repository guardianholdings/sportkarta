import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkFormToken,
  issueFormToken,
  MAX_FORM_MS,
  MIN_FORM_MS,
  verifyFormToken,
} from '../lib/form-token';

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

/**
 * Pre-launch audit, 2026-09: the key was random per process, so every deploy
 * (a restart on each push to main) invalidated every open «report a problem»
 * form — and the action answered "too fast, try again" to a token that could
 * never pass, forever.
 */
describe('the signing key survives a restart', () => {
  const SECRET = 'a-deployment-secret-that-is-at-least-32-characters';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function freshProcess() {
    // A new module instance AND no inherited fallback key: what a restarted
    // container sees.
    vi.resetModules();
    delete (globalThis as { __reportFormSecret?: unknown }).__reportFormSecret;
    return import('../lib/form-token');
  }

  it('a token issued before a restart verifies after it', async () => {
    vi.stubEnv('AUTH_SECRET', SECRET);
    const before = await freshProcess();
    const token = before.issueFormToken(1_700_000_000_000);
    const after = await freshProcess();
    expect(after.verifyFormToken(token)).toBe(1_700_000_000_000);
  });

  it('is bound to the deployment secret', async () => {
    vi.stubEnv('AUTH_SECRET', SECRET);
    const token = (await freshProcess()).issueFormToken(1_700_000_000_000);
    vi.stubEnv('AUTH_SECRET', `${SECRET}-rotated`);
    expect((await freshProcess()).verifyFormToken(token)).toBeNull();
  });

  it('never signs with the raw secret', async () => {
    vi.stubEnv('AUTH_SECRET', SECRET);
    const mod = await freshProcess();
    const ts = '1700000000000';
    const rawSigned = `${ts}.${createHmac('sha256', SECRET).update(ts).digest('base64url')}`;
    expect(mod.verifyFormToken(rawSigned)).toBeNull();
  });

  it('refuses a published placeholder in production and falls back to a private key', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_SECRET', 'change-me-to-at-least-32-random-characters');
    const mod = await freshProcess();
    const ts = '1700000000000';
    // Anybody who read .env.example could compute this signature.
    const placeholderKey = createHmac('sha256', 'change-me-to-at-least-32-random-characters')
      .update('pops/form-token/v1')
      .digest();
    const forged = `${ts}.${createHmac('sha256', placeholderKey).update(ts).digest('base64url')}`;
    expect(mod.verifyFormToken(forged)).toBeNull();
    // …while its own tokens still work within the process.
    expect(mod.verifyFormToken(mod.issueFormToken(1_700_000_000_000))).toBe(1_700_000_000_000);
  });
});

describe('checkFormToken — the two failures a person can hit are told apart', () => {
  const issued = 1_700_000_000_000;
  const token = issueFormToken(issued);

  it('accepts a form filled in at human speed', () => {
    expect(checkFormToken(token, issued + MIN_FORM_MS)).toEqual({ ok: true, issuedAt: issued });
    expect(checkFormToken(token, issued + MAX_FORM_MS)).toEqual({ ok: true, issuedAt: issued });
  });

  it('calls a quick submit "too fast" — the same token passes a moment later', () => {
    expect(checkFormToken(token, issued + MIN_FORM_MS - 1)).toEqual({
      ok: false,
      reason: 'tooFast',
    });
    // Our own clock stepping back a little is the same case, not a forgery.
    expect(checkFormToken(token, issued - 500)).toEqual({ ok: false, reason: 'tooFast' });
  });

  it('calls an old token "stale", never "too fast"', () => {
    expect(checkFormToken(token, issued + MAX_FORM_MS + 1)).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('treats an unverifiable token as stale, so the caller hands out a fresh one', () => {
    const ts = token.slice(0, token.indexOf('.'));
    expect(checkFormToken(`${ts}.forged`, issued + 10_000)).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(checkFormToken(null, issued)).toEqual({ ok: false, reason: 'stale' });
  });
});

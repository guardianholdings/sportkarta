import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { submitReport } from '../app/[locale]/obekt/[slug]/report-actions';
import { submitKeepingToken } from '../components/facility/report-form';
import { checkFormToken, issueFormToken, MAX_FORM_MS, MIN_FORM_MS } from '../lib/form-token';

/**
 * The anonymous «report a problem» form and its anti-spam token (pre-launch
 * audit, 2026-09).
 *
 * A stale token — the page open over two hours, or since before the key
 * changed — used to be answered "submitted too fast, try again", and the form
 * kept posting that same dead token: every retry failed the same way, forever.
 * The action now names the case and hands out a fresh token, and the form
 * keeps posting the fresh one.
 *
 * Only the token gate is under test. The rate limiter is stubbed to refuse, so
 * a submission that PASSES the gate stops right after it — "rateLimited" is the
 * proof the token was accepted — and nothing reaches the database.
 */

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.9' }),
}));
vi.mock('@/lib/report-rate-limit', () => ({
  reportRateLimiter: { check: () => ({ allowed: false }) },
}));
// The form module's locale-aware Link needs the Next runtime; only its submit
// wrapper is under test.
vi.mock('@/i18n/navigation', () => ({ Link: () => null }));

const NOW = 1_800_000_000_000;

function form(token: string | null): FormData {
  const data = new FormData();
  data.set('slug', 'striytbol-igrishta');
  data.set('issue', 'broken_equipment');
  if (token !== null) data.set('ts', token);
  return data;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('submitReport — the token gate', () => {
  it('answers a stale token "expired" with a fresh token, never "too fast"', async () => {
    const stale = issueFormToken(NOW - MAX_FORM_MS - 1);
    const state = await submitReport({ status: 'idle' }, form(stale));
    expect(state.status).toBe('error');
    expect(state.error).toBe('expired');
    expect(typeof state.formToken).toBe('string');
    // Issued NOW: the minimum time on the form still has to pass, so the
    // replacement hands a bot nothing it could not get by loading the page.
    expect(checkFormToken(state.formToken, NOW)).toEqual({ ok: false, reason: 'tooFast' });
    expect(checkFormToken(state.formToken, NOW + MIN_FORM_MS)).toEqual({
      ok: true,
      issuedAt: NOW,
    });
  });

  it('treats a forged or missing token the same way', async () => {
    const ts = String(NOW - 60_000);
    for (const token of [`${ts}.forged`, null]) {
      const state = await submitReport({ status: 'idle' }, form(token));
      expect(state.error, String(token)).toBe('expired');
      expect(state.formToken, String(token)).toBeTruthy();
    }
  });

  it('answers a quick submit "too fast" and keeps the token, which passes a moment later', async () => {
    const token = issueFormToken(NOW - 1_000);
    const quick = await submitReport({ status: 'idle' }, form(token));
    expect(quick).toEqual({ status: 'error', error: 'tooFast' });

    vi.setSystemTime(NOW + MIN_FORM_MS);
    const later = await submitReport(quick, form(token));
    expect(later.error).toBe('rateLimited');
  });

  it('accepts the replacement token once the minimum time has passed', async () => {
    const expired = await submitReport(
      { status: 'idle' },
      form(issueFormToken(NOW - MAX_FORM_MS - 1)),
    );
    vi.setSystemTime(NOW + MIN_FORM_MS);
    const retried = await submitReport(expired, form(expired.formToken ?? null));
    expect(retried.error).toBe('rateLimited');
  });
});

describe('the report form keeps posting the fresh token', () => {
  it('carries the replacement past an answer that brings none', async () => {
    // expired (fresh token) → rate limited (no token) → the form must still
    // hold the fresh one, or the next retry posts the page's dead token again.
    const expired = await submitKeepingToken(
      { status: 'idle' },
      form(issueFormToken(NOW - MAX_FORM_MS - 1)),
    );
    const fresh = expired.formToken;
    expect(fresh).toBeTruthy();

    vi.setSystemTime(NOW + MIN_FORM_MS);
    const limited = await submitKeepingToken(expired, form(fresh ?? null));
    expect(limited.error).toBe('rateLimited');
    expect(limited.formToken).toBe(fresh);
  });

  it('takes a newer replacement over an older one', async () => {
    const older = { status: 'error' as const, error: 'expired', formToken: 'older' };
    const next = await submitKeepingToken(older, form(null));
    expect(next.error).toBe('expired');
    expect(next.formToken).not.toBe('older');
  });

  it('adds nothing while the page token is still the one in use', async () => {
    const state = await submitKeepingToken({ status: 'idle' }, form(issueFormToken(NOW - 1_000)));
    expect(state).toEqual({ status: 'error', error: 'tooFast' });
  });
});

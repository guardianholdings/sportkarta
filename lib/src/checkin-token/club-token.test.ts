import { describe, expect, it } from 'vitest';

import {
  issueCheckinToken,
  issueClubToken,
  verifyCheckinToken,
  verifyClubToken,
  WINDOW_MS,
} from './index.js';

/**
 * v2 club tokens (kiosk location QR, per-club member QR). The properties that
 * matter are the v1 ones — signed, windowed, signature checked before window —
 * plus two new ones: the KIND is signed, so a location token can never pass as
 * a member token, and the two versions cannot be confused for each other.
 */

const SECRET = 'test-secret-0123456789abcdef0123456789';
const ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const AT = new Date('2026-10-24T10:00:30Z');

describe('club tokens (v2)', () => {
  it('round-trips each kind', () => {
    for (const kind of ['loc', 'mem'] as const) {
      const token = issueClubToken({ kind, id: ID, secret: SECRET, at: AT });
      expect(token.startsWith(`v2~${kind}~${ID}~`)).toBe(true);
      expect(token).not.toMatch(/\./);
      expect(verifyClubToken(token, SECRET, kind, AT)).toMatchObject({ ok: true, kind, id: ID });
    }
  });

  it('refuses a token of the other kind, after checking the signature', () => {
    const location = issueClubToken({ kind: 'loc', id: ID, secret: SECRET, at: AT });
    expect(verifyClubToken(location, SECRET, 'mem', AT)).toEqual({
      ok: false,
      reason: 'wrong_kind',
    });
    // Re-labelling the kind breaks the signature instead.
    const relabelled = location.replace('~loc~', '~mem~');
    expect(verifyClubToken(relabelled, SECRET, 'mem', AT)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('accepts the previous window and nothing older or newer', () => {
    const token = issueClubToken({ kind: 'loc', id: ID, secret: SECRET, at: AT });
    expect(verifyClubToken(token, SECRET, 'loc', new Date(AT.getTime() + WINDOW_MS)).ok).toBe(true);
    expect(verifyClubToken(token, SECRET, 'loc', new Date(AT.getTime() + 2 * WINDOW_MS))).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyClubToken(token, SECRET, 'loc', new Date(AT.getTime() - WINDOW_MS))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('reports a bad signature before an expiry', () => {
    const token = issueClubToken({
      kind: 'loc',
      id: ID,
      secret: 'another-secret-entirely-0000',
      at: AT,
    });
    const later = new Date(AT.getTime() + 10 * WINDOW_MS);
    expect(verifyClubToken(token, SECRET, 'loc', later)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('keeps v1 and v2 apart in both directions', () => {
    const v1 = issueCheckinToken({ occurrenceId: ID, secret: SECRET, at: AT });
    const v2 = issueClubToken({ kind: 'loc', id: ID, secret: SECRET, at: AT });
    expect(verifyClubToken(v1, SECRET, 'loc', AT)).toEqual({
      ok: false,
      reason: 'unsupported_version',
    });
    expect(verifyCheckinToken(v2, SECRET, AT).ok).toBe(false);
    expect(verifyCheckinToken(v1, SECRET, AT).ok).toBe(true);
  });

  it('refuses malformed input without throwing', () => {
    for (const token of [
      '',
      'v2',
      'v2~loc~not-a-uuid~1~x',
      `v2~xyz~${ID}~1~x`,
      `v2~loc~${ID}~abc~x`,
    ]) {
      expect(verifyClubToken(token, SECRET, 'loc', AT).ok).toBe(false);
    }
    expect(verifyClubToken('anything', '', 'loc', AT)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(() => issueClubToken({ kind: 'loc', id: 'nope', secret: SECRET })).toThrow();
  });
});

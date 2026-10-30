import { describe, expect, it } from 'vitest';

import {
  clubApiKeyPrefixOf,
  doorToken,
  generateClubApiKey,
  isClubApiKeyShape,
  parseDoorToken,
  verifyWebhookSignature,
  webhookSecretFor,
  webhookSignatureHeader,
} from './secrets.js';

const MASTER = 'a-test-master-secret-that-is-at-least-32-characters';
const DEVICE = '0f8b2c4e-1a2b-4c3d-9e8f-0123456789ab';

describe('club API keys', () => {
  it('generates recognisable keys of one shape', () => {
    const key = generateClubApiKey();
    expect(isClubApiKeyShape(key)).toBe(true);
    expect(key).toMatch(/^skbk_/);
    expect(clubApiKeyPrefixOf(key)).toHaveLength(11);
    expect(generateClubApiKey()).not.toBe(key);
  });

  it('refuses a near miss', () => {
    expect(isClubApiKeyShape('skbg_' + 'a'.repeat(43))).toBe(false);
    expect(isClubApiKeyShape('skbk_' + 'a'.repeat(42))).toBe(false);
    expect(isClubApiKeyShape(' skbk_' + 'a'.repeat(43))).toBe(false);
  });
});

describe('door tokens', () => {
  it('round-trips the device id and the secret', () => {
    const secret = 'S'.repeat(43);
    const token = doorToken(DEVICE, secret);
    expect(token).toBe(`skbd_0f8b2c4e1a2b4c3d9e8f0123456789ab.${secret}`);
    expect(parseDoorToken(token)).toEqual({ deviceId: DEVICE, secret });
  });

  it.each([
    '',
    'skbd_',
    `skbd_${'g'.repeat(32)}.${'S'.repeat(43)}`,
    `skbk_${'0'.repeat(32)}.${'S'.repeat(43)}`,
  ])('refuses %j', (value) => {
    expect(parseDoorToken(value)).toBeNull();
  });
});

describe('webhook signatures', () => {
  const body = '{"id":"x","type":"member.created"}';

  it('derives a stable secret per endpoint and version', () => {
    const one = webhookSecretFor(MASTER, DEVICE, 1);
    expect(one).toMatch(/^skbw_[A-Za-z0-9_-]{43}$/);
    expect(webhookSecretFor(MASTER, DEVICE, 1)).toBe(one);
    expect(webhookSecretFor(MASTER, DEVICE, 2)).not.toBe(one);
    expect(webhookSecretFor(`${MASTER}!`, DEVICE, 1)).not.toBe(one);
  });

  it('refuses a short master secret', () => {
    expect(() => webhookSecretFor('short', DEVICE, 1)).toThrow();
  });

  it('verifies what it signs, within the tolerance', () => {
    const secret = webhookSecretFor(MASTER, DEVICE, 1);
    const header = webhookSignatureHeader([secret], 1_800_000_000, body);
    expect(header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, header, body, 1_800_000_100, 300)).toBe(true);
  });

  it('refuses a tampered body, a wrong secret and a stale time', () => {
    const secret = webhookSecretFor(MASTER, DEVICE, 1);
    const header = webhookSignatureHeader([secret], 1_800_000_000, body);
    expect(verifyWebhookSignature(secret, header, `${body} `, 1_800_000_000, 300)).toBe(false);
    expect(
      verifyWebhookSignature(webhookSecretFor(MASTER, DEVICE, 2), header, body, 1_800_000_000, 300),
    ).toBe(false);
    expect(verifyWebhookSignature(secret, header, body, 1_800_000_301, 300)).toBe(false);
    expect(verifyWebhookSignature(secret, 'v1=abc', body, 1_800_000_000, 300)).toBe(false);
  });

  it('signs with both secrets during a rotation, and each verifies', () => {
    const old = webhookSecretFor(MASTER, DEVICE, 1);
    const next = webhookSecretFor(MASTER, DEVICE, 2);
    const header = webhookSignatureHeader([next, old], 1_800_000_000, body);
    expect(header.split(',')).toHaveLength(3);
    expect(verifyWebhookSignature(old, header, body, 1_800_000_000, 300)).toBe(true);
    expect(verifyWebhookSignature(next, header, body, 1_800_000_000, 300)).toBe(true);
  });
});

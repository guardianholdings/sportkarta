import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  APPLE_AUDIENCE,
  APPLE_CLIENT_SECRET_RENEW_SECONDS,
  APPLE_CLIENT_SECRET_TTL_SECONDS,
  appleClientSecretSource,
  mintAppleClientSecret,
  parseApplePrivateKey,
} from '@/lib/apple-client-secret';

/** A throwaway P-256 key, generated per run: no key material lives in the repo. */
function p256() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  return { pem, publicKey };
}

function body(pem: string): string {
  return pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
}

function decodePart(part: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function verifies(jwt: string, publicKey: KeyObject): boolean {
  const [header, payload, signature] = jwt.split('.');
  const sig = Buffer.from(signature ?? '', 'base64url');
  // JWS ES256 is the raw 64-byte r||s pair, not DER.
  expect(sig).toHaveLength(64);
  return verify(
    'sha256',
    Buffer.from(`${header}.${payload}`, 'utf8'),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    sig,
  );
}

const SIGNING = { clientId: 'bg.pops.web', teamId: 'TEAM123456', keyId: 'KEY1234567' };

describe('parseApplePrivateKey', () => {
  const { pem } = p256();

  it('takes the .p8 file as it is', () => {
    expect(parseApplePrivateKey(pem)?.asymmetricKeyType).toBe('ec');
  });

  it('takes it with Windows line endings or as one line with \\n escapes', () => {
    expect(parseApplePrivateKey(pem.replace(/\n/g, '\r\n'))).not.toBeNull();
    expect(parseApplePrivateKey(pem.replace(/\n/g, '\\n'))).not.toBeNull();
  });

  it('takes just the base64 body — the single line deploy.yml writes', () => {
    expect(parseApplePrivateKey(body(pem))).not.toBeNull();
  });

  it('refuses anything that is not a P-256 private key, so Apple stays off', () => {
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
    const publicOnly = p256().publicKey.export({ format: 'pem', type: 'spki' }).toString();

    for (const raw of [undefined, '', '   ', 'not a key', p384, rsa, publicOnly, `${body(pem)}!`]) {
      expect(parseApplePrivateKey(raw)).toBeNull();
    }
  });
});

describe('mintAppleClientSecret', () => {
  it('signs the claims Apple’s token endpoint checks, with ES256 and the key ID', () => {
    const { pem, publicKey } = p256();
    const key = parseApplePrivateKey(pem);
    if (!key) throw new Error('test key did not parse');

    const jwt = mintAppleClientSecret({ ...SIGNING, key }, 1_800_000_000);
    const [header, payload] = jwt.split('.');

    expect(decodePart(header)).toEqual({ alg: 'ES256', kid: SIGNING.keyId });
    expect(decodePart(payload)).toEqual({
      iss: SIGNING.teamId,
      iat: 1_800_000_000,
      exp: 1_800_000_000 + APPLE_CLIENT_SECRET_TTL_SECONDS,
      aud: APPLE_AUDIENCE,
      sub: SIGNING.clientId,
    });
    expect(verifies(jwt, publicKey)).toBe(true);
  });

  it('lives an hour, far inside Apple’s six-month ceiling', () => {
    expect(APPLE_CLIENT_SECRET_TTL_SECONDS).toBe(3600);
    expect(APPLE_CLIENT_SECRET_TTL_SECONDS).toBeLessThan(15_777_000);
  });
});

describe('appleClientSecretSource', () => {
  it('reuses a secret while it has time left and re-mints it before it expires', () => {
    const { pem, publicKey } = p256();
    const key = parseApplePrivateKey(pem);
    if (!key) throw new Error('test key did not parse');
    let nowMs = 1_800_000_000_000;
    const secret = appleClientSecretSource({ ...SIGNING, key }, () => nowMs);

    const first = secret();
    nowMs += 30 * 60 * 1000;
    expect(secret()).toBe(first);

    // Inside the renewal window: a fresh one, valid for a full hour from now.
    nowMs +=
      (APPLE_CLIENT_SECRET_TTL_SECONDS - APPLE_CLIENT_SECRET_RENEW_SECONDS) * 1000 - 30 * 60 * 1000;
    const second = secret();
    expect(second).not.toBe(first);
    const claims = decodePart(second.split('.')[1]);
    expect(claims.iat).toBe(Math.floor(nowMs / 1000));
    expect(claims.exp).toBe(Math.floor(nowMs / 1000) + APPLE_CLIENT_SECRET_TTL_SECONDS);
    expect(verifies(second, publicKey)).toBe(true);
  });

  it('never hands out a secret with less than the renewal margin left', () => {
    const key = parseApplePrivateKey(p256().pem);
    if (!key) throw new Error('test key did not parse');
    let nowMs = 1_800_000_000_000;
    const secret = appleClientSecretSource({ ...SIGNING, key }, () => nowMs);
    for (let minute = 0; minute < 6 * 60; minute += 7) {
      nowMs = 1_800_000_000_000 + minute * 60 * 1000;
      const exp = decodePart(secret().split('.')[1]).exp as number;
      expect(exp - Math.floor(nowMs / 1000)).toBeGreaterThan(APPLE_CLIENT_SECRET_RENEW_SECONDS);
    }
  });
});

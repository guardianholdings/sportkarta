import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

/**
 * Sign in with Apple has no client secret to store. The "secret" Apple's token
 * endpoint expects is a JWT we sign ourselves with the .p8 key from the Apple
 * developer account (ES256, kid = the key ID, iss = the team ID, sub = the
 * Services ID). Apple accepts one that lives up to six months — which is how
 * integrations elsewhere die silently half a year after launch. This one is
 * minted at runtime, lives an hour, and is re-minted before it expires, so
 * there is nothing to rotate and nothing to forget.
 *
 * Plain node:crypto: no JWT library, nothing new in the dependency tree.
 */

export const APPLE_AUDIENCE = 'https://appleid.apple.com';

/** Lifetime of each minted secret. */
export const APPLE_CLIENT_SECRET_TTL_SECONDS = 60 * 60;

/**
 * A secret with less than this left is replaced before use, so a token request
 * never sets off with a secret that expires on the way.
 */
export const APPLE_CLIENT_SECRET_RENEW_SECONDS = 5 * 60;

const PEM_BEGIN = '-----BEGIN PRIVATE KEY-----';
const PEM_END = '-----END PRIVATE KEY-----';
const BASE64_BODY = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The .p8 key in whichever shape it reached the environment: the file as is
 * (a local .env), with its line breaks written as `\n` escapes, or just its
 * base64 body — which is what deploy.yml writes, because a compose .env value
 * is a single line. Returns null for anything that is not an EC P-256 private
 * key, so a mangled key turns the provider off (lib/auth-config.ts) instead of
 * failing on the first visitor's click.
 */
export function parseApplePrivateKey(raw: string | undefined): KeyObject | null {
  if (!raw) return null;
  const body = raw
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!body || !BASE64_BODY.test(body)) return null;
  const lines = body.match(/.{1,64}/g) ?? [];
  try {
    const key = createPrivateKey({
      key: `${PEM_BEGIN}\n${lines.join('\n')}\n${PEM_END}\n`,
      format: 'pem',
    });
    if (key.asymmetricKeyType !== 'ec') return null;
    if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
    return key;
  } catch {
    return null;
  }
}

export interface AppleSigningInput {
  /** The Services ID — Apple's client_id for the web. */
  clientId: string;
  teamId: string;
  keyId: string;
  key: KeyObject;
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** One client-secret JWT, valid from `nowSeconds` for `ttlSeconds`. */
export function mintAppleClientSecret(
  input: AppleSigningInput,
  nowSeconds: number,
  ttlSeconds: number = APPLE_CLIENT_SECRET_TTL_SECONDS,
): string {
  const header = { alg: 'ES256', kid: input.keyId };
  const payload = {
    iss: input.teamId,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    aud: APPLE_AUDIENCE,
    sub: input.clientId,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  // JWS wants the raw 64-byte r||s signature, not the DER that sign() returns
  // by default.
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: input.key,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

/**
 * The current secret, re-minted when it has less than
 * APPLE_CLIENT_SECRET_RENEW_SECONDS to live. lib/auth-providers.ts reads it
 * through a getter on the provider options, which better-auth consults on
 * every authorization URL and token request.
 */
export function appleClientSecretSource(
  input: AppleSigningInput,
  now: () => number = Date.now,
): () => string {
  let current: { value: string; expiresAt: number } | null = null;
  return () => {
    const nowSeconds = Math.floor(now() / 1000);
    if (!current || current.expiresAt - nowSeconds <= APPLE_CLIENT_SECRET_RENEW_SECONDS) {
      current = {
        value: mintAppleClientSecret(input, nowSeconds),
        expiresAt: nowSeconds + APPLE_CLIENT_SECRET_TTL_SECONDS,
      };
    }
    return current.value;
  };
}

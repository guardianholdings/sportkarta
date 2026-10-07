import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  enabledSignInProviders,
  resolveAppleAuth,
  resolveFacebookAuth,
  resolveSignInProviders,
} from '@/lib/auth-config';
import {
  oauthErrorFallbackUrl,
  socialProviderOptions,
  stripProviderTokens,
  trustedOriginsFor,
  APPLE_ORIGIN,
} from '@/lib/auth-providers';
import { parseOAuthError } from '@/lib/oauth-error';

const P8 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();

const APPLE = {
  AUTH_APPLE_ENABLED: 'true',
  APPLE_CLIENT_ID: 'bg.pops.web',
  APPLE_TEAM_ID: 'TEAM123456',
  APPLE_KEY_ID: 'KEY1234567',
  APPLE_PRIVATE_KEY: P8,
};
const FACEBOOK = {
  AUTH_FACEBOOK_ENABLED: 'true',
  FACEBOOK_CLIENT_ID: 'fb-id',
  FACEBOOK_CLIENT_SECRET: 'fb-secret',
};
const GOOGLE = {
  AUTH_GOOGLE_ENABLED: 'true',
  GOOGLE_CLIENT_ID: 'g-id',
  GOOGLE_CLIENT_SECRET: 'g-secret',
};

describe('every provider ships off behind its own flag', () => {
  it('stays off with no flag, even with every credential present', () => {
    const appleKeys = { ...APPLE, AUTH_APPLE_ENABLED: undefined };
    const facebookKeys = { ...FACEBOOK, AUTH_FACEBOOK_ENABLED: undefined };
    expect(resolveAppleAuth(appleKeys)).toEqual({ enabled: false, reason: 'flag_off' });
    expect(resolveFacebookAuth(facebookKeys)).toEqual({ enabled: false, reason: 'flag_off' });
    expect(enabledSignInProviders({ ...appleKeys, ...facebookKeys })).toEqual([]);
  });

  it('turns on only for exactly "true" (any case, trimmed)', () => {
    expect(resolveFacebookAuth({ ...FACEBOOK, AUTH_FACEBOOK_ENABLED: ' TRUE ' }).enabled).toBe(
      true,
    );
    for (const flag of ['1', 'yes', 'on', 'false', '']) {
      expect(resolveFacebookAuth({ ...FACEBOOK, AUTH_FACEBOOK_ENABLED: flag }).enabled).toBe(false);
    }
  });

  it('keeps a half-configured provider off rather than showing a dead-end button', () => {
    for (const missing of [
      'APPLE_CLIENT_ID',
      'APPLE_TEAM_ID',
      'APPLE_KEY_ID',
      'APPLE_PRIVATE_KEY',
    ]) {
      expect(resolveAppleAuth({ ...APPLE, [missing]: '  ' })).toEqual({
        enabled: false,
        reason: 'missing_credentials',
      });
    }
    expect(resolveFacebookAuth({ ...FACEBOOK, FACEBOOK_CLIENT_SECRET: undefined })).toEqual({
      enabled: false,
      reason: 'missing_credentials',
    });
  });

  it('keeps Apple off when its key does not parse, instead of failing at Apple', () => {
    expect(resolveAppleAuth({ ...APPLE, APPLE_PRIVATE_KEY: 'truncated-key' })).toEqual({
      enabled: false,
      reason: 'invalid_private_key',
    });
  });

  it('lists the providers that are on, in button order', () => {
    expect(enabledSignInProviders({ ...FACEBOOK, ...APPLE, ...GOOGLE })).toEqual([
      'google',
      'apple',
      'facebook',
    ]);
    expect(enabledSignInProviders({ ...FACEBOOK })).toEqual(['facebook']);
  });
});

describe('socialProviderOptions', () => {
  it('configures nothing while every flag is off', () => {
    expect(socialProviderOptions(resolveSignInProviders({}))).toEqual({});
    expect(trustedOriginsFor(resolveSignInProviders({}))).toEqual([]);
  });

  it('copies neither the provider name nor the photo into the profile', () => {
    const options = socialProviderOptions(
      resolveSignInProviders({ ...GOOGLE, ...APPLE, ...FACEBOOK }),
    );
    for (const provider of [options.google, options.apple, options.facebook]) {
      expect(provider?.mapProfileToUser()).toEqual({ name: '', image: undefined });
    }
  });

  it('gives Apple a freshly signed client secret, never a stored one', () => {
    const options = socialProviderOptions(resolveSignInProviders(APPLE));
    const secret = options.apple?.clientSecret ?? '';
    expect(secret.split('.')).toHaveLength(3);
    const claims = JSON.parse(Buffer.from(secret.split('.')[1] ?? '', 'base64url').toString()) as {
      sub: string;
      iss: string;
    };
    expect(claims).toMatchObject({ sub: APPLE.APPLE_CLIENT_ID, iss: APPLE.APPLE_TEAM_ID });
    // Read twice within the hour: the same secret, not a new signature per read.
    expect(options.apple?.clientSecret).toBe(secret);
  });

  it('trusts Apple’s form POST origin only while Apple is on', () => {
    expect(trustedOriginsFor(resolveSignInProviders(APPLE))).toEqual([APPLE_ORIGIN]);
    expect(trustedOriginsFor(resolveSignInProviders({ ...GOOGLE, ...FACEBOOK }))).toEqual([]);
  });
});

describe('stripProviderTokens', () => {
  it('keeps the link and drops every token before the row is written', async () => {
    const result = await stripProviderTokens({
      providerId: 'google',
      accountId: '1234567890',
      userId: 'u1',
      scope: 'openid,email,profile',
      accessToken: 'ya29.secret',
      refreshToken: '1//secret',
      idToken: 'eyJ.secret',
      accessTokenExpiresAt: new Date(),
      refreshTokenExpiresAt: new Date(),
    });
    expect(result.data).toEqual({
      providerId: 'google',
      accountId: '1234567890',
      userId: 'u1',
      scope: 'openid,email,profile',
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    });
  });
});

describe('OAuth errors', () => {
  it('lands a lost callback on the sign-in page', () => {
    expect(oauthErrorFallbackUrl('https://pops.bg')).toBe('https://pops.bg/vhod');
    expect(oauthErrorFallbackUrl('https://pops.bg/')).toBe('https://pops.bg/vhod');
  });

  it('maps every code onto one of four messages and never echoes it', () => {
    expect(parseOAuthError(undefined, 'google')).toBeNull();
    expect(parseOAuthError('', 'google')).toBeNull();
    expect(parseOAuthError('account_not_linked', 'facebook')).toEqual({
      kind: 'account_not_linked',
      provider: 'facebook',
    });
    expect(parseOAuthError('email_not_found', 'facebook')).toEqual({
      kind: 'email_not_found',
      provider: 'facebook',
    });
    for (const code of ['access_denied', 'user_cancelled_authorize']) {
      expect(parseOAuthError(code, 'apple')).toEqual({ kind: 'cancelled', provider: 'apple' });
    }
    expect(parseOAuthError('<script>alert(1)</script>', 'google')).toEqual({
      kind: 'failed',
      provider: 'google',
    });
  });

  it('names only a provider we have', () => {
    expect(parseOAuthError('access_denied', 'evil-idp')?.provider).toBeNull();
    expect(parseOAuthError('access_denied', undefined)?.provider).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import {
  isAuthConfigured,
  resolveAdminEmails,
  resolveAuthBaseUrl,
  resolveAuthSecret,
  resolveGoogleAuth,
} from '@/lib/auth-config';

const SECRET = 'x'.repeat(48);

describe('Google login feature flag', () => {
  it('is off by default — the platform ships with no external identity provider', () => {
    expect(resolveGoogleAuth({})).toEqual({ enabled: false, reason: 'flag_off' });
    expect(resolveGoogleAuth({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' })).toEqual({
      enabled: false,
      reason: 'flag_off',
    });
  });

  it('turns on only when the flag and both credentials are present', () => {
    expect(
      resolveGoogleAuth({
        AUTH_GOOGLE_ENABLED: 'true',
        GOOGLE_CLIENT_ID: ' id ',
        GOOGLE_CLIENT_SECRET: ' secret ',
      }),
    ).toEqual({ enabled: true, clientId: 'id', clientSecret: 'secret' });
  });

  it('stays off when the flag is on but a credential is missing', () => {
    expect(resolveGoogleAuth({ AUTH_GOOGLE_ENABLED: 'true', GOOGLE_CLIENT_ID: 'id' })).toEqual({
      enabled: false,
      reason: 'missing_credentials',
    });
    expect(
      resolveGoogleAuth({
        AUTH_GOOGLE_ENABLED: 'true',
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: '   ',
      }),
    ).toEqual({ enabled: false, reason: 'missing_credentials' });
  });

  it('does not treat other truthy-looking values as on', () => {
    for (const value of ['1', 'yes', 'on', 'TRUE ']) {
      const state = resolveGoogleAuth({
        AUTH_GOOGLE_ENABLED: value,
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
      });
      // "TRUE " is accepted (trimmed, case-insensitive); the rest are not.
      expect(state.enabled).toBe(value.trim().toLowerCase() === 'true');
    }
  });
});

describe('auth secret', () => {
  it('never falls back to a fixed secret in production', () => {
    expect(resolveAuthSecret({ NODE_ENV: 'production' })).toBeNull();
    expect(isAuthConfigured({ NODE_ENV: 'production' })).toBe(false);
    // A too-short secret is as good as none.
    expect(resolveAuthSecret({ NODE_ENV: 'production', AUTH_SECRET: 'short' })).toBeNull();
    expect(resolveAuthSecret({ NODE_ENV: 'production', AUTH_SECRET: SECRET })).toBe(SECRET);
  });

  it('rejects the published .env.example placeholder in production', () => {
    // Long enough to pass the length check, and worthless as a secret because
    // it is committed — anyone could forge a session cookie with it.
    const placeholder = 'change-me-to-at-least-32-random-characters';
    expect(placeholder.length).toBeGreaterThanOrEqual(32);
    expect(resolveAuthSecret({ NODE_ENV: 'production', AUTH_SECRET: placeholder })).toBeNull();
    // Outside production it is accepted, so a fresh clone just runs.
    expect(resolveAuthSecret({ AUTH_SECRET: placeholder })).toBe(placeholder);
  });

  it('keeps local development usable without configuration', () => {
    const secret = resolveAuthSecret({});
    expect(secret).not.toBeNull();
    expect(secret).toContain('development-only');
  });
});

describe('base URL', () => {
  it('prefers AUTH_URL, falls back to the public site URL, and drops trailing slashes', () => {
    expect(
      resolveAuthBaseUrl({
        AUTH_URL: 'https://auth.example.org/',
        NEXT_PUBLIC_SITE_URL: 'https://x',
      }),
    ).toBe('https://auth.example.org');
    expect(resolveAuthBaseUrl({ NEXT_PUBLIC_SITE_URL: 'https://sportkarta.bg' })).toBe(
      'https://sportkarta.bg',
    );
    expect(resolveAuthBaseUrl({})).toBe('http://localhost:3000');
  });
});

describe('admin bootstrap allowlist', () => {
  it('normalises case and whitespace and ignores junk entries', () => {
    const emails = resolveAdminEmails({ ADMIN_EMAILS: ' Pavel@Example.ORG , ,broken, a@b.bg ' });
    expect([...emails].sort()).toEqual(['a@b.bg', 'pavel@example.org']);
  });

  it('is empty when unset — nothing is granted implicitly', () => {
    expect(resolveAdminEmails({}).size).toBe(0);
    expect(resolveAdminEmails({ ADMIN_EMAILS: '' }).size).toBe(0);
  });
});

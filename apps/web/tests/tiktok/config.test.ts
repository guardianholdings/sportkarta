import { describe, expect, it } from 'vitest';

import {
  buildAuthorizeUrl,
  getTikTokDemoConfig,
  resolveApiBase,
  TIKTOK_API_BASE,
  TIKTOK_SCOPES,
  type EnabledTikTokConfig,
} from '@/lib/tiktok/config';

const CREDENTIALS = { TIKTOK_CLIENT_KEY: 'test-key', TIKTOK_CLIENT_SECRET: 'test-secret' };
const SITE = { NEXT_PUBLIC_SITE_URL: 'https://pops.bg' };

function enabled(env: Record<string, string | undefined>): EnabledTikTokConfig {
  const config = getTikTokDemoConfig(env);
  if (!config.enabled) throw new Error(`expected the demo on, got ${config.reason}`);
  return config;
}

describe('/tiktok demo flag', () => {
  it('is off by default — the platform ships without it', () => {
    expect(getTikTokDemoConfig({})).toEqual({ enabled: false, reason: 'flag_off' });
    expect(getTikTokDemoConfig({ ...CREDENTIALS, ...SITE })).toEqual({
      enabled: false,
      reason: 'flag_off',
    });
  });

  it('turns on only when the flag and both credentials are present', () => {
    expect(enabled({ TIKTOK_DEMO_ENABLED: 'true', ...CREDENTIALS, ...SITE }).enabled).toBe(true);
    expect(enabled({ TIKTOK_DEMO_ENABLED: ' TRUE ', ...CREDENTIALS, ...SITE }).enabled).toBe(true);
  });

  it('stays off when the flag is on but a credential is missing or blank', () => {
    for (const env of [
      { TIKTOK_DEMO_ENABLED: 'true' },
      { TIKTOK_DEMO_ENABLED: 'true', TIKTOK_CLIENT_KEY: 'test-key' },
      { TIKTOK_DEMO_ENABLED: 'true', TIKTOK_CLIENT_SECRET: 'test-secret' },
      { TIKTOK_DEMO_ENABLED: 'true', TIKTOK_CLIENT_KEY: '  ', TIKTOK_CLIENT_SECRET: 'x' },
    ]) {
      expect(getTikTokDemoConfig(env)).toEqual({ enabled: false, reason: 'missing_credentials' });
    }
  });

  it('does not treat other truthy-looking values as on', () => {
    for (const value of ['1', 'yes', 'on', 'True1', 'enabled', '']) {
      expect(getTikTokDemoConfig({ TIKTOK_DEMO_ENABLED: value, ...CREDENTIALS }).enabled).toBe(
        false,
      );
    }
  });

  it('stays off on a site URL it cannot build a redirect URI from', () => {
    for (const url of ['not a url', 'ftp://pops.bg']) {
      expect(
        getTikTokDemoConfig({
          TIKTOK_DEMO_ENABLED: 'true',
          ...CREDENTIALS,
          NEXT_PUBLIC_SITE_URL: url,
        }),
      ).toEqual({ enabled: false, reason: 'bad_site_url' });
    }
  });

  it('builds the registered redirect URI and secure cookies from the https site', () => {
    const config = enabled({ TIKTOK_DEMO_ENABLED: 'true', ...CREDENTIALS, ...SITE });
    expect(config.redirectUri).toBe('https://pops.bg/auth/tiktok/callback');
    expect(config.siteOrigin).toBe('https://pops.bg');
    expect(config.secureCookies).toBe(true);
    expect(config.apiBase).toBe(TIKTOK_API_BASE);
  });

  it('keeps cookies usable on plain-http local development', () => {
    const config = enabled({
      TIKTOK_DEMO_ENABLED: 'true',
      ...CREDENTIALS,
      NEXT_PUBLIC_SITE_URL: 'http://localhost:3100',
    });
    expect(config.secureCookies).toBe(false);
    expect(config.redirectUri).toBe('http://localhost:3100/auth/tiktok/callback');
  });
});

describe('TikTok API base', () => {
  it('is TikTok’s own unless a loopback mock is configured', () => {
    expect(resolveApiBase(undefined)).toBe(TIKTOK_API_BASE);
    expect(resolveApiBase('')).toBe(TIKTOK_API_BASE);
    expect(resolveApiBase('http://127.0.0.1:4100/')).toBe('http://127.0.0.1:4100');
    expect(resolveApiBase('http://localhost:4100')).toBe('http://localhost:4100');
    expect(resolveApiBase('http://[::1]:4100')).toBe('http://[::1]:4100');
  });

  it('never sends the token exchange — which carries the secret — to any other host', () => {
    for (const raw of [
      'https://example.com',
      'http://localhost.example.com',
      'http://127.0.0.1.example.com',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(resolveApiBase(raw)).toBe(TIKTOK_API_BASE);
    }
  });
});

describe('the TikTok authorization URL', () => {
  const config = enabled({ TIKTOK_DEMO_ENABLED: 'true', ...CREDENTIALS, ...SITE });

  it('asks for exactly the two scopes the page uses', () => {
    expect([...TIKTOK_SCOPES]).toEqual(['user.info.basic', 'video.publish']);
    const url = new URL(buildAuthorizeUrl(config, 'state-123'));
    expect(url.origin + url.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(url.searchParams.get('scope')).toBe('user.info.basic,video.publish');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_key')).toBe('test-key');
    expect(url.searchParams.get('redirect_uri')).toBe('https://pops.bg/auth/tiktok/callback');
    expect(url.searchParams.get('state')).toBe('state-123');
  });

  it('never puts the client secret in the browser’s URL', () => {
    expect(buildAuthorizeUrl(config, 's')).not.toContain('test-secret');
  });
});

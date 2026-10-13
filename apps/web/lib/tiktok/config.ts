/**
 * The /tiktok demo (decision #41): an unlinked, flag-gated page that shows
 * TikTok's app reviewers Login Kit and the Content Posting API (Direct Post)
 * working end to end — sign in with TikTok, see whose account a post goes to,
 * fill in the post form TikTok's content-sharing guidelines require, upload one
 * video, watch its publish status.
 *
 * OFF unless TIKTOK_DEMO_ENABLED is exactly "true" (any case, trimmed) AND both
 * credentials are set — the same rule as AUTH_GOOGLE_ENABLED in
 * lib/auth-config.ts. Off means every route of the demo answers 404, as if it
 * did not exist.
 *
 * Pure: reads only the env object it is given, so the flag rules are unit
 * tested without a server.
 */

export interface TikTokEnv {
  /** process.env fits as is: these are the only keys read. */
  [key: string]: string | undefined;
  TIKTOK_DEMO_ENABLED?: string | undefined;
  TIKTOK_CLIENT_KEY?: string | undefined;
  TIKTOK_CLIENT_SECRET?: string | undefined;
  /**
   * Test-only: where the server sends its TikTok API calls. Honoured ONLY for
   * a loopback address (the e2e suite's mock); anything else is ignored and
   * the real API is used, so a stray value can never point the token exchange
   * — which carries the client secret — at another host.
   */
  TIKTOK_API_BASE_URL?: string | undefined;
  NEXT_PUBLIC_SITE_URL?: string | undefined;
}

/** TikTok's v2 authorization page (Login Kit for Web). */
export const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
/** TikTok's API host for the token, creator-info, post and status calls. */
export const TIKTOK_API_BASE = 'https://open.tiktokapis.com';
/**
 * user.info.basic for the token's identity, video.publish for Direct Post.
 * video.upload (drafts to the inbox) is not used by this page.
 */
export const TIKTOK_SCOPES = ['user.info.basic', 'video.publish'] as const;

export const TIKTOK_PAGE_PATH = '/tiktok';
export const TIKTOK_START_PATH = '/auth/tiktok/start';
/** Registered in the TikTok developer portal — must match to the character. */
export const TIKTOK_CALLBACK_PATH = '/auth/tiktok/callback';

export type TikTokDemoConfig =
  | {
      enabled: true;
      clientKey: string;
      clientSecret: string;
      /** e.g. https://pops.bg — the origin POSTs must come from. */
      siteOrigin: string;
      /** e.g. https://pops.bg/auth/tiktok/callback */
      redirectUri: string;
      apiBase: string;
      /** Secure cookies whenever the site itself is served over https. */
      secureCookies: boolean;
    }
  | { enabled: false; reason: 'flag_off' | 'missing_credentials' | 'bad_site_url' };

function flagOn(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLoopbackUrl(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname);
}

/** The API base: TikTok's, unless a loopback mock is configured (tests). */
export function resolveApiBase(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return TIKTOK_API_BASE;
  try {
    const url = new URL(value);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackUrl(url)) {
      return url.origin;
    }
  } catch {
    // Unparseable: fall through to the real API.
  }
  return TIKTOK_API_BASE;
}

export function getTikTokDemoConfig(env: TikTokEnv = process.env): TikTokDemoConfig {
  if (!flagOn(env.TIKTOK_DEMO_ENABLED)) return { enabled: false, reason: 'flag_off' };

  const clientKey = env.TIKTOK_CLIENT_KEY?.trim() ?? '';
  const clientSecret = env.TIKTOK_CLIENT_SECRET?.trim() ?? '';
  if (!clientKey || !clientSecret) return { enabled: false, reason: 'missing_credentials' };

  // Same default as lib/seo.ts. Production always sets it (compose.prod.yml
  // refuses to start without SITE_URL), and a wrong origin here only makes
  // TikTok refuse the redirect_uri — it cannot send anything elsewhere.
  let site: URL;
  try {
    site = new URL(env.NEXT_PUBLIC_SITE_URL?.trim() || 'http://localhost:3000');
  } catch {
    return { enabled: false, reason: 'bad_site_url' };
  }
  if (site.protocol !== 'https:' && site.protocol !== 'http:') {
    return { enabled: false, reason: 'bad_site_url' };
  }

  return {
    enabled: true,
    clientKey,
    clientSecret,
    siteOrigin: site.origin,
    redirectUri: new URL(TIKTOK_CALLBACK_PATH, site.origin).toString(),
    apiBase: resolveApiBase(env.TIKTOK_API_BASE_URL),
    secureCookies: site.protocol === 'https:',
  };
}

/** The TikTok authorization URL the start route redirects to. */
export function buildAuthorizeUrl(
  config: Extract<TikTokDemoConfig, { enabled: true }>,
  state: string,
): string {
  const url = new URL(TIKTOK_AUTHORIZE_URL);
  url.searchParams.set('client_key', config.clientKey);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', TIKTOK_SCOPES.join(','));
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

export type EnabledTikTokConfig = Extract<TikTokDemoConfig, { enabled: true }>;

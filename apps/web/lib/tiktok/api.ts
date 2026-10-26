import { isLoopbackUrl, TIKTOK_SCOPES, type EnabledTikTokConfig } from './config';
import { isPrivacyLevel, PUBLISH_STATUSES, type PrivacyLevel, type PublishStatus } from './shared';

/**
 * The TikTok calls the demo makes, over plain fetch (no SDK, no new
 * dependency): token, revoke, user info, creator info, video init, the upload
 * itself and the publish status. Every function returns a result object
 * instead of throwing, so a TikTok outage renders a message, never a 500.
 *
 * LOGGING: status codes and TikTok's error codes only. Never the token, the
 * open_id, the nickname, the caption or a URL with a query string — the
 * upload_url carries an upload token of its own.
 */

export type TikTokResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** TikTok's error code (snake_case), or one of ours: network, bad_response, http_<n>. */
      code: string;
      /** HTTP status, 0 when the request never got an answer. */
      status: number;
    };

export interface CreatorInfo {
  nickname: string;
  username: string;
  /** Only an https URL (or the e2e mock's loopback one); null otherwise. */
  avatarUrl: string | null;
  privacyLevelOptions: PrivacyLevel[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  /** null when TikTok did not say; the page then cannot pre-check the length. */
  maxVideoPostDurationSec: number | null;
}

export interface TokenGrant {
  accessToken: string;
  expiresInSec: number;
  /** The scopes the user granted; null when TikTok's answer did not say. */
  scopes: string[] | null;
}

export interface PostInfo {
  title: string;
  privacy_level: PrivacyLevel;
  disable_comment: boolean;
  disable_duet: boolean;
  disable_stitch: boolean;
  brand_content_toggle: boolean;
  brand_organic_toggle: boolean;
  is_aigc: boolean;
}

export interface PublishStatusInfo {
  status: PublishStatus;
  failReason: string | null;
}

const API_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const ERROR_CODE = /^[a-z][a-z0-9_.]{0,63}$/;

function safeCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && ERROR_CODE.test(value) ? value : fallback;
}

function log(call: string, status: number, code: string): void {
  console.warn(`[tiktok] ${call} failed: http=${status} code=${code}`);
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** TikTok's v2 envelope: { data, error: { code: "ok" | …, message, log_id } }. */
async function callApi(
  config: EnabledTikTokConfig,
  call: string,
  path: string,
  accessToken: string,
  body: unknown,
  method: 'GET' | 'POST' = 'POST',
): Promise<TikTokResult<Record<string, unknown>>> {
  let response: Response;
  try {
    response = await fetch(`${config.apiBase}${path}`, {
      method,
      headers:
        method === 'POST'
          ? {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json; charset=UTF-8',
            }
          : { Authorization: `Bearer ${accessToken}` },
      body: method === 'POST' && body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    log(call, 0, 'network');
    return { ok: false, code: 'network', status: 0 };
  }
  const json = await readJson(response);
  const error = (json?.error ?? null) as Record<string, unknown> | null;
  const code = safeCode(error?.code, response.ok ? 'bad_response' : `http_${response.status}`);
  if (!response.ok || code !== 'ok') {
    log(call, response.status, code);
    return { ok: false, code, status: response.status };
  }
  const data = json?.data;
  if (!data || typeof data !== 'object') {
    log(call, response.status, 'bad_response');
    return { ok: false, code: 'bad_response', status: response.status };
  }
  return { ok: true, data: data as Record<string, unknown> };
}

async function callOAuth(
  config: EnabledTikTokConfig,
  call: string,
  path: string,
  form: Record<string, string>,
): Promise<TikTokResult<Record<string, unknown>>> {
  let response: Response;
  try {
    response = await fetch(`${config.apiBase}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      },
      body: new URLSearchParams(form).toString(),
      cache: 'no-store',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    log(call, 0, 'network');
    return { ok: false, code: 'network', status: 0 };
  }
  const json = await readJson(response);
  if (!response.ok || !json || typeof json.error === 'string') {
    const code = safeCode(json?.error, response.ok ? 'bad_response' : `http_${response.status}`);
    log(call, response.status, code);
    return { ok: false, code, status: response.status };
  }
  return { ok: true, data: json };
}

/** The callback's code → an access token. Server-side only: it carries the secret. */
export async function exchangeCode(
  config: EnabledTikTokConfig,
  code: string,
): Promise<TikTokResult<TokenGrant>> {
  const result = await callOAuth(config, 'token', '/v2/oauth/token/', {
    client_key: config.clientKey,
    client_secret: config.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.redirectUri,
  });
  if (!result.ok) return result;
  const { access_token, expires_in, scope } = result.data;
  if (typeof access_token !== 'string' || access_token === '' || typeof expires_in !== 'number') {
    log('token', 200, 'bad_response');
    return { ok: false, code: 'bad_response', status: 200 };
  }
  const scopes =
    typeof scope === 'string'
      ? scope
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
  return { ok: true, data: { accessToken: access_token, expiresInSec: expires_in, scopes } };
}

/**
 * False when TikTok says the user left out a scope the demo needs (TikTok lets
 * a user untick video.publish). When it does not say, the post itself would
 * answer scope_not_authorized, so the sign-in goes ahead.
 */
export function hasRequiredScopes(scopes: readonly string[] | null): boolean {
  if (scopes === null) return true;
  return TIKTOK_SCOPES.every((scope) => scopes.includes(scope));
}

/** Best effort: the session is dropped on our side whatever TikTok answers. */
export async function revokeToken(
  config: EnabledTikTokConfig,
  accessToken: string,
): Promise<boolean> {
  const result = await callOAuth(config, 'revoke', '/v2/oauth/revoke/', {
    client_key: config.clientKey,
    client_secret: config.clientSecret,
    token: accessToken,
  });
  return result.ok;
}

function avatarUrl(config: EnabledTikTokConfig, raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return url.toString();
    // The e2e mock serves its avatar over http on 127.0.0.1.
    if (isLoopbackUrl(new URL(config.apiBase)) && url.origin === config.apiBase)
      return url.toString();
  } catch {
    // fall through
  }
  return null;
}

function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * What a TikTok error means for the person at the page — the vocabulary the
 * routes answer with and the page and form show messages for.
 */
export type TikTokProblem =
  | 'session'
  | 'cannot_post'
  | 'private_account_required'
  | 'privacy'
  | 'scope'
  | 'tiktok_rate'
  | 'tiktok';

export function classifyTikTokError(code: string, status: number): TikTokProblem {
  switch (code) {
    case 'access_token_invalid':
      return 'session';
    // creator_info and video/init: this creator cannot post right now.
    case 'spam_risk_too_many_posts':
    case 'spam_risk_user_banned_from_posting':
    case 'reached_active_user_cap':
      return 'cannot_post';
    // Until TikTok's audit, the posting account itself must be private.
    case 'unaudited_client_can_only_post_to_private_accounts':
      return 'private_account_required';
    case 'privacy_level_option_mismatch':
      return 'privacy';
    case 'scope_not_authorized':
      return 'scope';
    case 'rate_limit_exceeded':
      return 'tiktok_rate';
    default:
      return status === 401 ? 'session' : 'tiktok';
  }
}

/**
 * Who signed in (user.info.basic): display name and avatar only. open_id and
 * union_id are not requested — the demo has no use for an identifier.
 */
export interface TikTokUser {
  displayName: string;
  avatarUrl: string | null;
}

export const USER_INFO_FIELDS = 'display_name,avatar_url';

export async function fetchUserInfo(
  config: EnabledTikTokConfig,
  accessToken: string,
): Promise<TikTokResult<TikTokUser>> {
  const result = await callApi(
    config,
    'user_info',
    `/v2/user/info/?fields=${USER_INFO_FIELDS}`,
    accessToken,
    undefined,
    'GET',
  );
  if (!result.ok) return result;
  const user = result.data.user;
  if (!user || typeof user !== 'object') {
    log('user_info', 200, 'bad_response');
    return { ok: false, code: 'bad_response', status: 200 };
  }
  const u = user as Record<string, unknown>;
  return {
    ok: true,
    data: { displayName: clip(u.display_name, 100), avatarUrl: avatarUrl(config, u.avatar_url) },
  };
}

/** The creator's posting settings (video.publish), fetched fresh for every render and post. */
export async function queryCreatorInfo(
  config: EnabledTikTokConfig,
  accessToken: string,
): Promise<TikTokResult<CreatorInfo>> {
  const result = await callApi(
    config,
    'creator_info',
    '/v2/post/publish/creator_info/query/',
    accessToken,
    undefined,
  );
  if (!result.ok) return result;
  const d = result.data;
  const options = Array.isArray(d.privacy_level_options)
    ? d.privacy_level_options.filter(isPrivacyLevel)
    : [];
  const max = d.max_video_post_duration_sec;
  return {
    ok: true,
    data: {
      nickname: clip(d.creator_nickname, 100),
      username: clip(d.creator_username, 100),
      avatarUrl: avatarUrl(config, d.creator_avatar_url),
      privacyLevelOptions: [...new Set(options)],
      commentDisabled: d.comment_disabled === true,
      duetDisabled: d.duet_disabled === true,
      stitchDisabled: d.stitch_disabled === true,
      maxVideoPostDurationSec:
        typeof max === 'number' && Number.isFinite(max) && max > 0 ? max : null,
    },
  };
}

/** Where TikTok may tell us to PUT the video: its upload hosts, over https. */
export function isAllowedUploadUrl(config: EnabledTikTokConfig, raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && url.hostname.endsWith('.tiktokapis.com')) return true;
    return isLoopbackUrl(new URL(config.apiBase)) && url.origin === config.apiBase;
  } catch {
    return false;
  }
}

/** Direct Post, FILE_UPLOAD, the whole file as one chunk (≤ 50 MB < TikTok's 64 MB). */
export async function initFileUpload(
  config: EnabledTikTokConfig,
  accessToken: string,
  postInfo: PostInfo,
  videoSize: number,
): Promise<TikTokResult<{ publishId: string; uploadUrl: string }>> {
  const result = await callApi(config, 'video_init', '/v2/post/publish/video/init/', accessToken, {
    post_info: postInfo,
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: videoSize,
      chunk_size: videoSize,
      total_chunk_count: 1,
    },
  });
  if (!result.ok) return result;
  const { publish_id, upload_url } = result.data;
  if (
    typeof publish_id !== 'string' ||
    publish_id === '' ||
    publish_id.length > 64 ||
    typeof upload_url !== 'string' ||
    !isAllowedUploadUrl(config, upload_url)
  ) {
    log('video_init', 200, 'bad_response');
    return { ok: false, code: 'bad_response', status: 200 };
  }
  return { ok: true, data: { publishId: publish_id, uploadUrl: upload_url } };
}

export async function uploadVideo(
  uploadUrl: string,
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: string,
): Promise<TikTokResult<null>> {
  let response: Response;
  try {
    response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
        'Content-Range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
      },
      body: bytes,
      cache: 'no-store',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch {
    log('upload', 0, 'network');
    return { ok: false, code: 'network', status: 0 };
  }
  // 201: every byte arrived and TikTok starts posting. Anything else is a failure.
  await response.body?.cancel().catch(() => undefined);
  if (response.status !== 201 && response.status !== 200) {
    log('upload', response.status, `http_${response.status}`);
    return { ok: false, code: `http_${response.status}`, status: response.status };
  }
  return { ok: true, data: null };
}

export async function fetchPublishStatus(
  config: EnabledTikTokConfig,
  accessToken: string,
  publishId: string,
): Promise<TikTokResult<PublishStatusInfo>> {
  const result = await callApi(config, 'status', '/v2/post/publish/status/fetch/', accessToken, {
    publish_id: publishId,
  });
  if (!result.ok) return result;
  const { status, fail_reason } = result.data;
  if (typeof status !== 'string' || !(PUBLISH_STATUSES as readonly string[]).includes(status)) {
    log('status', 200, 'bad_response');
    return { ok: false, code: 'bad_response', status: 200 };
  }
  return {
    ok: true,
    data: {
      status: status as PublishStatus,
      failReason:
        typeof fail_reason === 'string' && fail_reason ? safeCode(fail_reason, 'unknown') : null,
    },
  };
}

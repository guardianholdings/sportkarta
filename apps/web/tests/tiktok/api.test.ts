import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classifyTikTokError,
  exchangeCode,
  fetchPublishStatus,
  fetchUserInfo,
  hasRequiredScopes,
  initFileUpload,
  isAllowedUploadUrl,
  queryCreatorInfo,
  revokeToken,
  uploadVideo,
  type PostInfo,
} from '@/lib/tiktok/api';

import { CREATOR_INFO, enabledConfig, mockFetch, mp4Bytes, tiktokJson } from './helpers';

const TOKEN = 'act.test-access-token';
const config = enabledConfig();

const POST_INFO: PostInfo = {
  title: '',
  privacy_level: 'SELF_ONLY',
  disable_comment: true,
  disable_duet: true,
  disable_stitch: true,
  brand_content_toggle: false,
  brand_organic_toggle: false,
  is_aigc: false,
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  // Whatever happened, no log line ever carries the token or the secret.
  for (const [line] of warn.mock.calls) {
    expect(String(line)).not.toContain(TOKEN);
    expect(String(line)).not.toContain('test-client-secret');
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the code exchange', () => {
  it('posts the code with the secret, server-side, and reads the granted scopes', async () => {
    const { calls } = mockFetch({
      '/v2/oauth/token/': () =>
        Response.json({
          access_token: TOKEN,
          expires_in: 86400,
          open_id: 'open-id',
          refresh_token: 'rft.x',
          refresh_expires_in: 31536000,
          scope: 'user.info.basic,video.publish',
          token_type: 'Bearer',
        }),
    });
    const grant = await exchangeCode(config, 'code-123');
    expect(grant).toEqual({
      ok: true,
      data: {
        accessToken: TOKEN,
        expiresInSec: 86400,
        scopes: ['user.info.basic', 'video.publish'],
      },
    });
    const [call] = calls;
    expect(call?.url.toString()).toBe('https://open.tiktokapis.com/v2/oauth/token/');
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(call?.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('code-123');
    expect(form.get('client_key')).toBe('test-client-key');
    expect(form.get('client_secret')).toBe('test-client-secret');
    expect(form.get('redirect_uri')).toBe('https://pops.bg/auth/tiktok/callback');
  });

  it('answers TikTok’s OAuth error, and a network failure, without throwing', async () => {
    mockFetch({
      '/v2/oauth/token/': () =>
        Response.json(
          { error: 'invalid_grant', error_description: 'Authorization code is expired.' },
          { status: 400 },
        ),
    });
    expect(await exchangeCode(config, 'old')).toEqual({
      ok: false,
      code: 'invalid_grant',
      status: 400,
    });

    mockFetch({
      '/v2/oauth/token/': () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await exchangeCode(config, 'x')).toEqual({ ok: false, code: 'network', status: 0 });
  });

  it('refuses a grant without a token', async () => {
    mockFetch({ '/v2/oauth/token/': () => Response.json({ expires_in: 10 }) });
    expect(await exchangeCode(config, 'x')).toEqual({
      ok: false,
      code: 'bad_response',
      status: 200,
    });
  });
});

describe('scopes', () => {
  it('needs both scopes when TikTok says which were granted', () => {
    expect(hasRequiredScopes(['user.info.basic', 'video.publish'])).toBe(true);
    expect(hasRequiredScopes(['video.publish', 'user.info.basic', 'video.upload'])).toBe(true);
    expect(hasRequiredScopes(['user.info.basic'])).toBe(false);
    expect(hasRequiredScopes([])).toBe(false);
  });

  it('lets the sign-in through when TikTok does not say (the post would refuse instead)', () => {
    expect(hasRequiredScopes(null)).toBe(true);
  });
});

describe('revoking a token', () => {
  it('posts the token to TikTok’s revoke endpoint and reports the outcome', async () => {
    const { calls } = mockFetch({ '/v2/oauth/revoke/': () => Response.json({}) });
    expect(await revokeToken(config, TOKEN)).toBe(true);
    expect(new URLSearchParams(calls[0]?.body).get('token')).toBe(TOKEN);

    mockFetch({ '/v2/oauth/revoke/': () => new Response('', { status: 500 }) });
    expect(await revokeToken(config, TOKEN)).toBe(false);
  });
});

describe('user info (user.info.basic)', () => {
  it('asks for the display name and avatar only, with the bearer token', async () => {
    const { calls } = mockFetch({
      '/v2/user/info/': () =>
        tiktokJson({
          user: { display_name: 'POPS', avatar_url: 'https://p16.tiktokcdn.example/a.jpeg' },
        }),
    });
    expect(await fetchUserInfo(config, TOKEN)).toEqual({
      ok: true,
      data: { displayName: 'POPS', avatarUrl: 'https://p16.tiktokcdn.example/a.jpeg' },
    });
    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.searchParams.get('fields')).toBe('display_name,avatar_url');
    expect(call?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('drops an avatar that is not https', async () => {
    mockFetch({
      '/v2/user/info/': () =>
        tiktokJson({
          user: { display_name: 'POPS', avatar_url: 'http://insecure.example/a.jpeg' },
        }),
    });
    const result = await fetchUserInfo(config, TOKEN);
    expect(result.ok && result.data.avatarUrl).toBeNull();
  });

  it('passes TikTok’s error code through', async () => {
    mockFetch({ '/v2/user/info/': () => tiktokJson({}, 'access_token_invalid', 401) });
    expect(await fetchUserInfo(config, TOKEN)).toEqual({
      ok: false,
      code: 'access_token_invalid',
      status: 401,
    });
  });
});

describe('creator info (video.publish)', () => {
  it('reads the posting settings the form must follow', async () => {
    const { calls } = mockFetch({
      '/v2/post/publish/creator_info/query/': () =>
        tiktokJson({
          ...CREATOR_INFO,
          privacy_level_options: [
            ...CREATOR_INFO.privacy_level_options,
            'SOMETHING_NEW',
            'SELF_ONLY',
          ],
        }),
    });
    expect(await queryCreatorInfo(config, TOKEN)).toEqual({
      ok: true,
      data: {
        nickname: 'POPS',
        username: 'popsbg',
        avatarUrl: 'https://p16.tiktokcdn.example/avatar.jpeg',
        privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
        commentDisabled: false,
        duetDisabled: false,
        stitchDisabled: true,
        maxVideoPostDurationSec: 300,
      },
    });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('reports a creator who cannot post right now', async () => {
    mockFetch({
      '/v2/post/publish/creator_info/query/': () => tiktokJson({}, 'spam_risk_too_many_posts'),
    });
    expect(await queryCreatorInfo(config, TOKEN)).toEqual({
      ok: false,
      code: 'spam_risk_too_many_posts',
      status: 200,
    });
  });

  it('never repeats an error code that is not a plain code', async () => {
    mockFetch({
      '/v2/post/publish/creator_info/query/': () =>
        tiktokJson({}, 'Bearer act.something <script>', 400),
    });
    expect(await queryCreatorInfo(config, TOKEN)).toEqual({
      ok: false,
      code: 'http_400',
      status: 400,
    });
  });
});

describe('what a TikTok error means on the page', () => {
  it.each([
    ['access_token_invalid', 401, 'session'],
    ['spam_risk_too_many_posts', 200, 'cannot_post'],
    ['spam_risk_user_banned_from_posting', 200, 'cannot_post'],
    ['reached_active_user_cap', 200, 'cannot_post'],
    ['unaudited_client_can_only_post_to_private_accounts', 403, 'private_account_required'],
    ['privacy_level_option_mismatch', 400, 'privacy'],
    ['scope_not_authorized', 401, 'scope'],
    ['rate_limit_exceeded', 429, 'tiktok_rate'],
    ['http_401', 401, 'session'],
    ['internal_error', 500, 'tiktok'],
    ['network', 0, 'tiktok'],
  ] as const)('%s (http %i) → %s', (code, status, problem) => {
    expect(classifyTikTokError(code, status)).toBe(problem);
  });
});

describe('posting a video (Direct Post, FILE_UPLOAD)', () => {
  const UPLOAD_URL = 'https://open-upload.tiktokapis.com/video/?upload_id=1&upload_token=x';

  it('announces the whole file as one chunk', async () => {
    const { calls } = mockFetch({
      '/v2/post/publish/video/init/': () =>
        tiktokJson({ publish_id: 'v_pub_file~v2-1.123', upload_url: UPLOAD_URL }),
    });
    expect(await initFileUpload(config, TOKEN, POST_INFO, 2048)).toEqual({
      ok: true,
      data: { publishId: 'v_pub_file~v2-1.123', uploadUrl: UPLOAD_URL },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      post_info: POST_INFO,
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: 2048,
        chunk_size: 2048,
        total_chunk_count: 1,
      },
    });
  });

  it('never uploads anywhere but TikTok’s upload hosts', async () => {
    for (const url of [
      'http://open-upload.tiktokapis.com/video/',
      'https://tiktokapis.com.attacker.example/video/',
      'https://attacker.example/video/',
      'not a url',
    ]) {
      expect(isAllowedUploadUrl(config, url)).toBe(false);
      mockFetch({
        '/v2/post/publish/video/init/': () =>
          tiktokJson({ publish_id: 'v_pub_1', upload_url: url }),
      });
      expect(await initFileUpload(config, TOKEN, POST_INFO, 10)).toEqual({
        ok: false,
        code: 'bad_response',
        status: 200,
      });
    }
    expect(isAllowedUploadUrl(config, UPLOAD_URL)).toBe(true);
  });

  it('PUTs the bytes with their range and type, and needs a 201', async () => {
    const { calls } = mockFetch({ '/video/': () => new Response(null, { status: 201 }) });
    expect(await uploadVideo(UPLOAD_URL, mp4Bytes(16), 'video/mp4')).toEqual({
      ok: true,
      data: null,
    });
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.headers.get('content-range')).toBe('bytes 0-15/16');
    expect(calls[0]?.headers.get('content-type')).toBe('video/mp4');
    // The upload URL carries its own token: no Authorization header goes with it.
    expect(calls[0]?.headers.get('authorization')).toBeNull();

    mockFetch({ '/video/': () => new Response('bad', { status: 400 }) });
    expect(await uploadVideo(UPLOAD_URL, mp4Bytes(16), 'video/mp4')).toEqual({
      ok: false,
      code: 'http_400',
      status: 400,
    });
  });

  it('reads the publish status', async () => {
    const { calls } = mockFetch({
      '/v2/post/publish/status/fetch/': () =>
        tiktokJson({ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [] }),
    });
    expect(await fetchPublishStatus(config, TOKEN, 'v_pub_1')).toEqual({
      ok: true,
      data: { status: 'PUBLISH_COMPLETE', failReason: null },
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ publish_id: 'v_pub_1' });

    mockFetch({
      '/v2/post/publish/status/fetch/': () =>
        tiktokJson({ status: 'FAILED', fail_reason: 'file_format_check_failed' }),
    });
    expect(await fetchPublishStatus(config, TOKEN, 'v_pub_1')).toEqual({
      ok: true,
      data: { status: 'FAILED', failReason: 'file_format_check_failed' },
    });

    mockFetch({
      '/v2/post/publish/status/fetch/': () => tiktokJson({ status: 'SOMETHING_ELSE' }),
    });
    expect((await fetchPublishStatus(config, TOKEN, 'v_pub_1')).ok).toBe(false);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tiktokSessions } from '@/lib/tiktok/session-store';

import {
  CREATOR_INFO,
  mockFetch,
  mp4Bytes,
  resetTikTokGlobals,
  stubEnabledEnv,
  tiktokJson,
} from './helpers';

const SITE = 'https://pops.bg';
const TOKEN = 'act.route-test-token';
const UPLOAD_URL = 'https://open-upload.tiktokapis.com/video/?upload_id=7&upload_token=t';

function request(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: Uint8Array<ArrayBuffer> } = {},
): NextRequest {
  return new NextRequest(new URL(path, SITE), init);
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookie(response: Response, name: string): string | undefined {
  return setCookies(response).find((c) => c.startsWith(`${name}=`));
}

async function multipart(
  fields: Record<string, string>,
  video: File | null = new File([mp4Bytes()], 'clip.mp4', { type: 'video/mp4' }),
) {
  const form = new FormData();
  if (video) form.set('video', video);
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  const encoded = new Response(form);
  const type = encoded.headers.get('content-type') ?? '';
  const body = new Uint8Array(await encoded.arrayBuffer());
  return { type, body };
}

async function publishRequest(
  sessionId: string,
  fields: Record<string, string> = { privacy_level: 'SELF_ONLY' },
  extra: Record<string, string> = {},
  video?: File | null,
) {
  const { type, body } = await multipart(fields, video);
  return request('/tiktok/publish', {
    method: 'POST',
    body,
    headers: {
      origin: SITE,
      cookie: `pops_tiktok_session=${sessionId}`,
      'content-type': type,
      'content-length': String(body.byteLength),
      ...extra,
    },
  });
}

const logs: string[] = [];

beforeEach(() => {
  resetTikTokGlobals();
  logs.length = 0;
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  }
});

afterEach(() => {
  // No log line ever carries the token, the code, the secret or a caption.
  for (const line of logs) {
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain('test-client-secret');
    expect(line).not.toContain('auth-code-xyz');
    expect(line).not.toContain('my caption');
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetTikTokGlobals();
});

describe('with the flag off, the demo does not exist', () => {
  beforeEach(() => {
    vi.stubEnv('TIKTOK_DEMO_ENABLED', 'false');
    vi.stubEnv('TIKTOK_CLIENT_KEY', 'test-client-key');
    vi.stubEnv('TIKTOK_CLIENT_SECRET', 'test-client-secret');
  });

  it('every route answers 404 and calls nobody', async () => {
    const { fn } = mockFetch({});
    const start = await import('@/app/auth/tiktok/start/route');
    const callback = await import('@/app/auth/tiktok/callback/route');
    const publish = await import('@/app/tiktok/publish/route');
    const status = await import('@/app/tiktok/status/route');
    const logout = await import('@/app/tiktok/logout/route');

    const responses = [
      start.GET(request('/auth/tiktok/start')),
      await callback.GET(request('/auth/tiktok/callback?code=auth-code-xyz&state=s')),
      await publish.POST(await publishRequest('x')),
      await status.GET(request('/tiktok/status?publish_id=v_pub_1')),
      await logout.POST(request('/tiktok/logout', { method: 'POST', headers: { origin: SITE } })),
    ];
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(setCookies(response)).toEqual([]);
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it('the page 404s per request and can never be baked static', () => {
    const page = readFileSync(join(__dirname, '../../app/tiktok/page.tsx'), 'utf8');
    expect(page).toMatch(/if \(!config\.enabled\) notFound\(\);/);
    expect(page).toMatch(/export const dynamic = 'force-dynamic';/);
  });
});

describe('„Continue with TikTok“', () => {
  beforeEach(stubEnabledEnv);

  it('sends the browser to TikTok with a fresh state, kept in a short-lived httpOnly cookie', async () => {
    const { GET } = await import('@/app/auth/tiktok/start/route');
    const response = GET(request('/auth/tiktok/start'));
    expect(response.status).toBe(302);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    const state = location.searchParams.get('state') ?? '';
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const set = cookie(response, 'pops_tiktok_state') ?? '';
    expect(set).toContain(`pops_tiktok_state=${state}`);
    expect(set).toMatch(/Path=\/auth\/tiktok/);
    expect(set).toMatch(/Max-Age=600/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/SameSite=lax/i);

    const again = new URL(GET(request('/auth/tiktok/start')).headers.get('location') ?? '');
    expect(again.searchParams.get('state')).not.toBe(state);
  });

  it('is rate limited per client', async () => {
    const { GET } = await import('@/app/auth/tiktok/start/route');
    const headers = { 'x-forwarded-for': '203.0.113.7' };
    for (let i = 0; i < 20; i++) {
      expect(GET(request('/auth/tiktok/start', { headers })).status).toBe(302);
    }
    const limited = GET(request('/auth/tiktok/start', { headers }));
    expect(limited.status).toBe(303);
    expect(limited.headers.get('location')).toBe(`${SITE}/tiktok?error=rate`);
  });
});

describe('the TikTok callback', () => {
  beforeEach(stubEnabledEnv);

  const STATE = 'S'.repeat(43);
  function callbackRequest(query: string, state: string | null = STATE) {
    return request(`/auth/tiktok/callback?${query}`, {
      headers: state ? { cookie: `pops_tiktok_state=${state}` } : {},
    });
  }

  async function expectFailure(response: Response, error: string) {
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${SITE}/tiktok?error=${error}`);
    expect(cookie(response, 'pops_tiktok_state')).toMatch(/Max-Age=0/);
    expect(cookie(response, 'pops_tiktok_session')).toBeUndefined();
  }

  it('signs in: exchanges the code server-side and hands the browser only a session id', async () => {
    const { calls } = mockFetch({
      '/v2/oauth/token/': () =>
        Response.json({
          access_token: TOKEN,
          expires_in: 86400,
          scope: 'user.info.basic,video.publish',
        }),
    });
    const { GET } = await import('@/app/auth/tiktok/callback/route');
    const response = await GET(callbackRequest(`code=auth-code-xyz&state=${STATE}`));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${SITE}/tiktok`);
    expect(cookie(response, 'pops_tiktok_state')).toMatch(/Max-Age=0/);
    const session = cookie(response, 'pops_tiktok_session') ?? '';
    expect(session).toMatch(/Path=\/tiktok/);
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Max-Age=7200/);
    expect(session).not.toContain(TOKEN);

    const id = /pops_tiktok_session=([^;]+)/.exec(session)?.[1];
    expect(tiktokSessions().get(id)?.accessToken).toBe(TOKEN);
    expect(new URLSearchParams(calls[0]?.body).get('code')).toBe('auth-code-xyz');
  });

  it('a user who said no lands back on the page with a plain message', async () => {
    const { fn } = mockFetch({});
    const { GET } = await import('@/app/auth/tiktok/callback/route');
    await expectFailure(
      await GET(callbackRequest(`error=access_denied&error_description=x&state=${STATE}`)),
      'denied',
    );
    await expectFailure(await GET(callbackRequest(`error=server_error&state=${STATE}`)), 'tiktok');
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses a missing code, and a state that does not match its cookie', async () => {
    const { fn } = mockFetch({});
    const { GET } = await import('@/app/auth/tiktok/callback/route');
    await expectFailure(await GET(callbackRequest(`state=${STATE}`)), 'missing');
    await expectFailure(await GET(callbackRequest('code=auth-code-xyz')), 'missing');
    await expectFailure(
      await GET(callbackRequest(`code=auth-code-xyz&state=${'T'.repeat(43)}`)),
      'state',
    );
    await expectFailure(
      await GET(callbackRequest(`code=auth-code-xyz&state=${STATE}`, null)),
      'state',
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('reports a failed code exchange', async () => {
    mockFetch({
      '/v2/oauth/token/': () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    });
    const { GET } = await import('@/app/auth/tiktok/callback/route');
    await expectFailure(await GET(callbackRequest(`code=auth-code-xyz&state=${STATE}`)), 'token');
  });

  it('revokes and refuses a grant without permission to post', async () => {
    const { calls } = mockFetch({
      '/v2/oauth/token/': () =>
        Response.json({ access_token: TOKEN, expires_in: 86400, scope: 'user.info.basic' }),
      '/v2/oauth/revoke/': () => Response.json({}),
    });
    const { GET } = await import('@/app/auth/tiktok/callback/route');
    await expectFailure(await GET(callbackRequest(`code=auth-code-xyz&state=${STATE}`)), 'scope');
    expect(calls.map((c) => c.url.pathname)).toEqual(['/v2/oauth/token/', '/v2/oauth/revoke/']);
    expect(tiktokSessions().size).toBe(0);
  });
});

describe('posting a video', () => {
  beforeEach(stubEnabledEnv);

  function tiktokMocks(creator: Record<string, unknown> = CREATOR_INFO) {
    return mockFetch({
      '/v2/post/publish/creator_info/query/': () => tiktokJson(creator),
      '/v2/post/publish/video/init/': () =>
        tiktokJson({ publish_id: 'v_pub_file~v2-1.42', upload_url: UPLOAD_URL }),
      '/video/': () => new Response(null, { status: 201 }),
      '/v2/post/publish/status/fetch/': () => tiktokJson({ status: 'PROCESSING_UPLOAD' }),
    });
  }

  it('posts the file to TikTok and then answers status for that post only', async () => {
    const { calls } = tiktokMocks();
    const { id } = tiktokSessions().create(TOKEN, 3600);
    const { POST } = await import('@/app/tiktok/publish/route');
    const response = await POST(
      await publishRequest(id, { privacy_level: 'SELF_ONLY', title: 'my caption' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ publishId: 'v_pub_file~v2-1.42' });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'POST /v2/post/publish/creator_info/query/',
      'POST /v2/post/publish/video/init/',
      'PUT /video/',
    ]);
    const init = JSON.parse(calls[1]?.body ?? '{}') as { post_info: Record<string, unknown> };
    expect(init.post_info).toMatchObject({ title: 'my caption', privacy_level: 'SELF_ONLY' });
    expect(calls[2]?.body).toBe(`<${mp4Bytes().byteLength} bytes>`);

    const { GET } = await import('@/app/tiktok/status/route');
    const cookieHeader = { cookie: `pops_tiktok_session=${id}` };
    const status = await GET(
      request('/tiktok/status?publish_id=v_pub_file~v2-1.42', { headers: cookieHeader }),
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ status: 'PROCESSING_UPLOAD', failReason: null });

    const other = await GET(
      request('/tiktok/status?publish_id=v_pub_other', { headers: cookieHeader }),
    );
    expect(other.status).toBe(404);
    const stranger = await GET(request('/tiktok/status?publish_id=v_pub_file~v2-1.42'));
    expect(stranger.status).toBe(401);
  });

  it('takes POSTs from our own pages only', async () => {
    const { fn } = tiktokMocks();
    const { id } = tiktokSessions().create(TOKEN, 3600);
    const { POST } = await import('@/app/tiktok/publish/route');
    expect(
      (await POST(await publishRequest(id, undefined, { origin: 'https://attacker.example' })))
        .status,
    ).toBe(403);
    expect(fn).not.toHaveBeenCalled();
  });

  it('needs a live session', async () => {
    const { fn } = tiktokMocks();
    const { POST } = await import('@/app/tiktok/publish/route');
    const response = await POST(await publishRequest('A'.repeat(43)));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'session' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('turns an oversized upload away before reading it', async () => {
    const { fn } = tiktokMocks();
    const { id } = tiktokSessions().create(TOKEN, 3600);
    const { POST } = await import('@/app/tiktok/publish/route');
    const response = await POST(
      await publishRequest(id, undefined, { 'content-length': String(51 * 1024 * 1024) }),
    );
    expect(response.status).toBe(413);
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses a privacy level TikTok did not offer, and a file that is not a video', async () => {
    tiktokMocks();
    const { id } = tiktokSessions().create(TOKEN, 3600);
    const { POST } = await import('@/app/tiktok/publish/route');

    const privacy = await POST(
      await publishRequest(id, { privacy_level: 'MUTUAL_FOLLOW_FRIENDS' }),
    );
    expect(privacy.status).toBe(400);
    expect(await privacy.json()).toEqual({ error: 'privacy' });

    const fake = new File([new Uint8Array(512).fill(0x41)], 'fake.mp4', { type: 'video/mp4' });
    const notVideo = await POST(await publishRequest(id, undefined, {}, fake));
    expect(notVideo.status).toBe(415);
    expect(await notVideo.json()).toEqual({ error: 'bad_type' });
  });

  it('shows TikTok’s private-account rule for an unaudited app', async () => {
    mockFetch({
      '/v2/post/publish/creator_info/query/': () => tiktokJson(CREATOR_INFO),
      '/v2/post/publish/video/init/': () =>
        tiktokJson({}, 'unaudited_client_can_only_post_to_private_accounts', 403),
    });
    const { id } = tiktokSessions().create(TOKEN, 3600);
    const { POST } = await import('@/app/tiktok/publish/route');
    const response = await POST(await publishRequest(id));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'private_account_required' });
  });

  it('forgets a session TikTok no longer accepts', async () => {
    mockFetch({
      '/v2/post/publish/creator_info/query/': () => tiktokJson({}, 'access_token_invalid', 401),
    });
    const { id } = tiktokSessions().create(TOKEN, 3600);
    const { POST } = await import('@/app/tiktok/publish/route');
    const response = await POST(await publishRequest(id));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'session' });
    expect(tiktokSessions().get(id)).toBeNull();
  });

  it('frees the upload slot whatever happened', async () => {
    mockFetch({
      '/v2/post/publish/creator_info/query/': () => {
        throw new TypeError('fetch failed');
      },
    });
    const { id } = tiktokSessions().create(TOKEN, 3600);
    const { POST } = await import('@/app/tiktok/publish/route');
    expect((await POST(await publishRequest(id))).status).toBe(502);
    expect((await POST(await publishRequest(id))).status).toBe(502);
  });
});

describe('„Disconnect TikTok“', () => {
  beforeEach(stubEnabledEnv);

  it('revokes the token, forgets the session and clears the cookie', async () => {
    const { calls } = mockFetch({ '/v2/oauth/revoke/': () => Response.json({}) });
    const { id } = tiktokSessions().create(TOKEN, 3600);
    const { POST } = await import('@/app/tiktok/logout/route');
    const response = await POST(
      request('/tiktok/logout', {
        method: 'POST',
        headers: { origin: SITE, cookie: `pops_tiktok_session=${id}` },
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${SITE}/tiktok?signed_out=1`);
    expect(cookie(response, 'pops_tiktok_session')).toMatch(/Max-Age=0/);
    expect(tiktokSessions().get(id)).toBeNull();
    expect(calls.map((c) => c.url.pathname)).toEqual(['/v2/oauth/revoke/']);
  });

  it('ignores a cross-site POST', async () => {
    const { fn } = mockFetch({});
    const { id } = tiktokSessions().create(TOKEN, 3600);
    const { POST } = await import('@/app/tiktok/logout/route');
    const response = await POST(
      request('/tiktok/logout', {
        method: 'POST',
        headers: { origin: 'https://attacker.example', cookie: `pops_tiktok_session=${id}` },
      }),
    );
    expect(response.status).toBe(403);
    expect(tiktokSessions().get(id)).not.toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});

import { vi } from 'vitest';

import { getTikTokDemoConfig, type EnabledTikTokConfig } from '@/lib/tiktok/config';

/** The env the /tiktok tests run with: the demo on, a test key, the https site. */
export const ENABLED_ENV = {
  TIKTOK_DEMO_ENABLED: 'true',
  TIKTOK_CLIENT_KEY: 'test-client-key',
  TIKTOK_CLIENT_SECRET: 'test-client-secret',
  NEXT_PUBLIC_SITE_URL: 'https://pops.bg',
} as const;

export function enabledConfig(): EnabledTikTokConfig {
  const config = getTikTokDemoConfig({ ...ENABLED_ENV });
  if (!config.enabled) throw new Error('test config should be enabled');
  return config;
}

export function stubEnabledEnv(): void {
  for (const [key, value] of Object.entries(ENABLED_ENV)) vi.stubEnv(key, value);
  vi.stubEnv('TIKTOK_API_BASE_URL', '');
}

/** Forget the process-wide sessions, limiters and upload slot between tests. */
export function resetTikTokGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  delete g.__tiktokDemoSessions;
  delete g.__tiktokDemoLimiters;
  delete g.__tiktokDemoUploadBusy;
}

export interface RecordedCall {
  url: URL;
  method: string;
  headers: Headers;
  body: string;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

/**
 * Replace fetch with a router keyed by URL pathname (TikTok's API paths) and
 * record every call. An unexpected path fails loudly.
 */
export function mockFetch(handlers: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const body = init?.body;
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body:
        typeof body === 'string'
          ? body
          : body instanceof Uint8Array
            ? `<${body.byteLength} bytes>`
            : body == null
              ? ''
              : String(body),
    };
    calls.push(call);
    const handler = handlers[url.pathname];
    if (!handler) throw new Error(`unexpected fetch to ${url.pathname}`);
    return handler(call);
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

export function tiktokJson(data: unknown, code = 'ok', status = 200): Response {
  return Response.json(
    { data, error: { code, message: code === 'ok' ? '' : code, log_id: 'test-log' } },
    { status },
  );
}

export const CREATOR_INFO = {
  creator_avatar_url: 'https://p16.tiktokcdn.example/avatar.jpeg',
  creator_username: 'popsbg',
  creator_nickname: 'POPS',
  privacy_level_options: ['PUBLIC_TO_EVERYONE', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
  comment_disabled: false,
  duet_disabled: false,
  stitch_disabled: true,
  max_video_post_duration_sec: 300,
};

/** An MP4's first bytes (`ftyp isom`) and some padding: enough for the type check. */
export function mp4Bytes(size = 2048): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  return bytes;
}

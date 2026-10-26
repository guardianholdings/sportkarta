import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

/**
 * A loopback stand-in for TikTok's API, for e2e/tiktok-demo.spec.ts. The web
 * server is started with TIKTOK_API_BASE_URL pointing here (playwright.config.ts);
 * lib/tiktok/config.ts honours that variable only for a loopback address. The
 * one hop that runs in the browser — TikTok's own authorization page — is
 * answered by the spec with page.route(), so nothing in the suite reaches
 * TikTok.
 *
 * It answers like the v2 API (an { data, error: { code } } envelope) and
 * checks what the real one would: the client credentials and code on the
 * token exchange, the bearer token on every call, the post's JSON body.
 */

export const TIKTOK_MOCK_PORT = Number(process.env.E2E_TIKTOK_MOCK_PORT ?? 4110);
export const TIKTOK_MOCK_ORIGIN = `http://127.0.0.1:${TIKTOK_MOCK_PORT}`;

/** The env the web server needs for the demo (playwright.config.ts). Test values only. */
export const TIKTOK_E2E_ENV = {
  TIKTOK_DEMO_ENABLED: 'true',
  TIKTOK_CLIENT_KEY: 'e2e-client-key',
  TIKTOK_CLIENT_SECRET: 'e2e-client-secret',
  TIKTOK_API_BASE_URL: TIKTOK_MOCK_ORIGIN,
};

export const E2E_CODE = 'e2e-authorization-code';
export const E2E_ACCESS_TOKEN = 'act.e2e-access-token';
const ACCESS_TOKEN = E2E_ACCESS_TOKEN;
export const E2E_PUBLISH_ID = 'v_pub_file~v2-e2e.1';

export interface MockCall {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const AVATAR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#1d4ed8"/></svg>';

export class TikTokMock {
  readonly calls: MockCall[] = [];
  /** Set to make video/init fail with this TikTok error code. */
  initError: string | null = null;
  private statusPolls = 0;
  private server: Server | null = null;

  callsTo(path: string): MockCall[] {
    return this.calls.filter((c) => c.path === path);
  }

  reset(): void {
    this.calls.length = 0;
    this.initError = null;
    this.statusPolls = 0;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', TIKTOK_MOCK_ORIGIN);
        const call: MockCall = {
          method: req.method ?? 'GET',
          path: url.pathname,
          headers: req.headers,
          body: Buffer.concat(chunks),
        };
        this.calls.push(call);
        const { status, type, body } = this.answer(call);
        res.writeHead(status, { 'Content-Type': type });
        res.end(body);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(TIKTOK_MOCK_PORT, '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private answer(call: MockCall): { status: number; type: string; body: string } {
    const json = (status: number, value: unknown) => ({
      status,
      type: 'application/json',
      body: JSON.stringify(value),
    });
    const ok = (data: unknown) =>
      json(200, { data, error: { code: 'ok', message: '', log_id: 'e2e' } });
    const fail = (status: number, code: string) =>
      json(status, { data: {}, error: { code, message: code, log_id: 'e2e' } });
    const authorized = call.headers.authorization === `Bearer ${ACCESS_TOKEN}`;

    switch (`${call.method} ${call.path}`) {
      case 'POST /v2/oauth/token/': {
        const form = new URLSearchParams(call.body.toString('utf8'));
        const valid =
          form.get('client_key') === TIKTOK_E2E_ENV.TIKTOK_CLIENT_KEY &&
          form.get('client_secret') === TIKTOK_E2E_ENV.TIKTOK_CLIENT_SECRET &&
          form.get('grant_type') === 'authorization_code' &&
          form.get('code') === E2E_CODE &&
          Boolean(form.get('redirect_uri')?.endsWith('/auth/tiktok/callback'));
        if (!valid) return json(400, { error: 'invalid_grant', error_description: 'e2e' });
        return json(200, {
          access_token: ACCESS_TOKEN,
          expires_in: 86400,
          open_id: 'e2e-open-id',
          refresh_token: 'rft.e2e',
          refresh_expires_in: 31536000,
          scope: 'user.info.basic,video.publish',
          token_type: 'Bearer',
        });
      }
      case 'POST /v2/oauth/revoke/':
        return json(200, {});
      case 'GET /avatar.svg':
        return { status: 200, type: 'image/svg+xml', body: AVATAR_SVG };
      case 'GET /v2/user/info/':
        if (!authorized) return fail(401, 'access_token_invalid');
        return ok({
          user: { display_name: 'POPS e2e', avatar_url: `${TIKTOK_MOCK_ORIGIN}/avatar.svg` },
        });
      case 'POST /v2/post/publish/creator_info/query/':
        if (!authorized) return fail(401, 'access_token_invalid');
        return ok({
          creator_avatar_url: `${TIKTOK_MOCK_ORIGIN}/avatar.svg`,
          creator_username: 'pops_e2e',
          creator_nickname: 'POPS e2e',
          // A private account: TikTok offers no public option for it.
          privacy_level_options: ['MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
          comment_disabled: false,
          duet_disabled: false,
          stitch_disabled: true,
          max_video_post_duration_sec: 600,
        });
      case 'POST /v2/post/publish/video/init/':
        if (!authorized) return fail(401, 'access_token_invalid');
        if (this.initError) return fail(403, this.initError);
        return ok({
          publish_id: E2E_PUBLISH_ID,
          upload_url: `${TIKTOK_MOCK_ORIGIN}/upload/e2e?upload_id=1&upload_token=e2e`,
        });
      case 'PUT /upload/e2e':
        return { status: 201, type: 'text/plain', body: '' };
      case 'POST /v2/post/publish/status/fetch/':
        if (!authorized) return fail(401, 'access_token_invalid');
        this.statusPolls += 1;
        return ok({ status: this.statusPolls > 1 ? 'PUBLISH_COMPLETE' : 'PROCESSING_UPLOAD' });
      default:
        return json(404, { error: { code: 'not_found' } });
    }
  }
}

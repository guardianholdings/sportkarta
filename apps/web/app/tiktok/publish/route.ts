import type { NextRequest } from 'next/server';

import {
  classifyTikTokError,
  initFileUpload,
  queryCreatorInfo,
  uploadVideo,
  type TikTokProblem,
} from '@/lib/tiktok/api';
import { getTikTokDemoConfig } from '@/lib/tiktok/config';
import {
  isSameOriginPost,
  jsonResponse,
  notFoundResponse,
  SESSION_COOKIE,
} from '@/lib/tiktok/http';
import {
  acceptedVideoType,
  MAX_REQUEST_BYTES,
  parsePublishForm,
  readBodyCapped,
  type PublishFormError,
} from '@/lib/tiktok/publish-form';
import {
  releaseUploadSlot,
  tiktokLimiters,
  tiktokSessions,
  tryAcquireUploadSlot,
} from '@/lib/tiktok/session-store';

/**
 * Post one video to the signed-in creator's TikTok (Direct Post, FILE_UPLOAD).
 *
 * Checks, in order: the flag, same origin, the session, the rate limit, one
 * upload at a time, the size (Content-Length, then counted while reading),
 * the creator's latest settings, the form (type, caption length, privacy among
 * TikTok's options, the commercial-content rules), the file's own bytes. Only
 * then does anything go to TikTok: video/init with the whole file as one chunk,
 * and one PUT of the bytes to the upload_url TikTok returned (https, on
 * *.tiktokapis.com — checked in lib/tiktok/api.ts).
 *
 * The video exists only in this request's memory: nothing is written to disk
 * and nothing is kept once the response is sent.
 */

export const dynamic = 'force-dynamic';

const FORM_ERROR_STATUS: Record<PublishFormError, number> = {
  no_video: 400,
  too_large: 413,
  bad_type: 415,
  title_too_long: 400,
  privacy: 400,
  disclosure_choice: 400,
  branded_private: 400,
};

const PROBLEM_STATUS: Record<TikTokProblem, number> = {
  session: 401,
  cannot_post: 403,
  private_account_required: 403,
  privacy: 400,
  scope: 403,
  tiktok_rate: 429,
  tiktok: 502,
};

export async function POST(request: NextRequest) {
  const config = getTikTokDemoConfig();
  if (!config.enabled) return notFoundResponse();
  if (!isSameOriginPost(request, config.siteOrigin))
    return jsonResponse({ error: 'forbidden' }, 403);

  const sessions = tiktokSessions();
  const sessionId = request.cookies.get(SESSION_COOKIE)?.value;
  const session = sessions.get(sessionId);
  if (!sessionId || !session) return jsonResponse({ error: 'session' }, 401);

  const verdict = tiktokLimiters().publish.check(sessionId);
  if (!verdict.allowed) {
    const response = jsonResponse({ error: 'rate' }, 429);
    response.headers.set('Retry-After', String(Math.ceil(verdict.retryAfterMs / 1000)));
    return response;
  }

  const length = Number(request.headers.get('content-length'));
  if (!Number.isSafeInteger(length) || length <= 0) {
    return jsonResponse({ error: 'length_required' }, 411);
  }
  if (length > MAX_REQUEST_BYTES) return jsonResponse({ error: 'too_large' }, 413);

  if (!tryAcquireUploadSlot()) {
    const response = jsonResponse({ error: 'busy' }, 503);
    response.headers.set('Retry-After', '30');
    return response;
  }
  try {
    const raw = await readBodyCapped(request.body, MAX_REQUEST_BYTES);
    if (!raw) return jsonResponse({ error: 'too_large' }, 413);

    let form: FormData;
    try {
      form = await new Response(raw, {
        headers: { 'Content-Type': request.headers.get('content-type') ?? '' },
      }).formData();
    } catch {
      return jsonResponse({ error: 'bad_request' }, 400);
    }

    // The latest settings, not the ones the page rendered with: privacy
    // options and interaction switches can change in between.
    const creator = await queryCreatorInfo(config, session.accessToken);
    if (!creator.ok) return problem(classifyTikTokError(creator.code, creator.status), sessionId);

    const parsed = parsePublishForm(form, creator.data);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, FORM_ERROR_STATUS[parsed.error]);

    const bytes = new Uint8Array(await parsed.value.video.arrayBuffer());
    const type = acceptedVideoType(parsed.value.video.type, bytes.subarray(0, 16));
    if (!type) return jsonResponse({ error: 'bad_type' }, 415);

    const init = await initFileUpload(
      config,
      session.accessToken,
      parsed.value.postInfo,
      bytes.byteLength,
    );
    if (!init.ok) return problem(classifyTikTokError(init.code, init.status), sessionId);

    const upload = await uploadVideo(init.data.uploadUrl, bytes, type);
    if (!upload.ok) return jsonResponse({ error: 'upload' }, 502);

    sessions.rememberPublishId(sessionId, init.data.publishId);
    console.info(`[tiktok] post sent: bytes=${bytes.byteLength}`);
    return jsonResponse({ publishId: init.data.publishId });
  } finally {
    releaseUploadSlot();
  }
}

function problem(kind: TikTokProblem, sessionId: string) {
  // TikTok no longer accepts this token: forget it, so the page offers a
  // fresh sign-in instead of failing the same way again.
  if (kind === 'session') tiktokSessions().delete(sessionId);
  return jsonResponse({ error: kind }, PROBLEM_STATUS[kind]);
}

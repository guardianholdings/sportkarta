import type { NextRequest } from 'next/server';

import { classifyTikTokError, fetchPublishStatus } from '@/lib/tiktok/api';
import { getTikTokDemoConfig } from '@/lib/tiktok/config';
import { jsonResponse, notFoundResponse, SESSION_COOKIE } from '@/lib/tiktok/http';
import { tiktokLimiters, tiktokSessions } from '@/lib/tiktok/session-store';

/**
 * The status of a post this session started (TikTok's
 * /v2/post/publish/status/fetch/). The form polls it every 5 seconds for up to
 * two minutes. A publish_id the session did not start answers 404, so the
 * route cannot be used to look up anyone else's post.
 */

export const dynamic = 'force-dynamic';

const PUBLISH_ID = /^[\w.~-]{1,64}$/;

export async function GET(request: NextRequest) {
  const config = getTikTokDemoConfig();
  if (!config.enabled) return notFoundResponse();

  const sessions = tiktokSessions();
  const sessionId = request.cookies.get(SESSION_COOKIE)?.value;
  const session = sessions.get(sessionId);
  if (!sessionId || !session) return jsonResponse({ error: 'session' }, 401);

  const publishId = request.nextUrl.searchParams.get('publish_id') ?? '';
  if (!PUBLISH_ID.test(publishId) || !sessions.ownsPublishId(sessionId, publishId)) {
    return jsonResponse({ error: 'unknown_post' }, 404);
  }

  if (!tiktokLimiters().status.check(sessionId).allowed)
    return jsonResponse({ error: 'rate' }, 429);

  const result = await fetchPublishStatus(config, session.accessToken, publishId);
  if (!result.ok) {
    const kind = classifyTikTokError(result.code, result.status);
    if (kind === 'session') sessions.delete(sessionId);
    return jsonResponse({ error: kind }, kind === 'session' ? 401 : 502);
  }
  return jsonResponse({ status: result.data.status, failReason: result.data.failReason });
}

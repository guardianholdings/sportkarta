import { toNextJsHandler } from 'better-auth/next-js';

import { getAuth } from '@/lib/auth';

// better-auth's public endpoints: session, sign-out and the Google callback.
// Everything else it ships (including OTP issue/verify) answers 404 here — see
// DISABLED_AUTH_PATHS in lib/auth-surface.ts. Always per-request; never
// prerendered or cached.
export const dynamic = 'force-dynamic';

/**
 * 503 rather than a crash when auth is not configured: a deployment missing
 * AUTH_SECRET keeps serving the public map, and only sign-in is unavailable.
 */
function unavailable(): Response {
  return Response.json(
    { error: 'auth_unavailable' },
    { status: 503, headers: { 'cache-control': 'no-store' } },
  );
}

const auth = getAuth();
const handlers = auth ? toNextJsHandler(auth) : null;

export function GET(request: Request): Promise<Response> | Response {
  return handlers ? handlers.GET(request) : unavailable();
}

export function POST(request: Request): Promise<Response> | Response {
  return handlers ? handlers.POST(request) : unavailable();
}

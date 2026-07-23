import { OPEN_DATA_LICENSE } from '@sportkarta/lib/opendata';

import { verifyApiKey } from '@/lib/opendata/keys';
import { chargeOpenDataRequest, rateLimitHeaders, type LimitDecision } from '@/lib/opendata/limits';
import { siteUrl } from '@/lib/seo';

/** Absolute URL on the canonical origin. `siteUrl()` returns the origin only. */
export function siteAbsolute(path: string): string {
  return `${siteUrl()}${path}`;
}

const absolute = siteAbsolute;

/**
 * The context an un-limited route passes: the dumps are deliberately free of
 * the rate limiter (see limits.ts), but they still carry the licence and CORS
 * headers, so they share the response helpers.
 */
export const UNMETERED: OpenDataContext = {
  keyId: null,
  decision: { allowed: true, limit: 0, remaining: 0, retryAfterSeconds: 0 },
};

/**
 * The shared envelope every open-data API response goes through (Stage 6.1).
 *
 * AUTHENTICATION IS `Authorization: Bearer` AND NOTHING ELSE, and the two
 * exclusions are the security design of this surface:
 *
 *   NO `?api_key=`. A credential in a query string is written to every access
 *   log, proxy log and browser history between the client and us, and it ends
 *   up in the Referer header of anything the response links to. The privacy
 *   rules already forbid personal data in URL parameters; a key is worse than
 *   personal data, because it is live. Header only, and the docs say why so
 *   nobody adds the convenience back.
 *
 *   NO SESSION COOKIE. These responses are `Access-Control-Allow-Origin: *`,
 *   and a CORS-open endpoint that honours a cookie is a CSRF surface: any page
 *   on the internet could read our API as whoever is signed in. The API
 *   therefore ignores cookies entirely — being signed in on the website grants
 *   nothing here, which is fine, because a key grants nothing but throughput
 *   either.
 *
 * ATTRIBUTION IS A HEADER, NOT A PAGE SOMEBODY VISITS. Every response carries
 * `Link: <…/danni/litsenz>; rel="license"` and `X-License`, so a consumer who
 * only ever sees bytes still receives the terms. The GeoJSON and JSON bodies
 * repeat it as members; CSV cannot without ceasing to be CSV, which is
 * precisely why the header exists.
 *
 * The payload does not depend on the key, so the cache headers do not vary on
 * Authorization: a keyed and an anonymous request for the same URL are
 * byte-identical, and a shared cache serving one to the other leaks nothing.
 */

export interface OpenDataContext {
  keyId: string | null;
  decision: LimitDecision;
}

/** Public, cacheable: the corpus moves on the scale of hours, not seconds. */
export const OPEN_DATA_CACHE = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function licenseHeaders(): Record<string, string> {
  return {
    'X-License': OPEN_DATA_LICENSE.id,
    // ASCII: header values are latin-1, so the `©` form arrives corrupted.
    'X-Attribution': OPEN_DATA_LICENSE.attributionAscii,
    Link: `<${absolute('/danni/litsenz')}>; rel="license"; title="${OPEN_DATA_LICENSE.name}"`,
  };
}

/**
 * CORS, wide open and deliberately so — this is published data, and a browser
 * application on somebody else's origin is a first-class consumer of it. Only
 * GET and only the Authorization header, because there is nothing to write and
 * no other header the API reads.
 */
export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Resolve the caller and charge their budget.
 *
 * An unrecognised or revoked key is NOT an error. It falls through to the
 * anonymous budget and serves the request, because the alternative — 401 on a
 * public dataset — would mean a client whose key was revoked stops receiving
 * data it is entitled to receive without any key at all. The only thing a bad
 * key costs is the higher limit.
 */
export async function openDataContext(request: Request): Promise<OpenDataContext> {
  const token = bearerToken(request);
  const verified = token ? await verifyApiKey(token) : null;
  const keyId = verified?.id ?? null;
  return { keyId, decision: chargeOpenDataRequest(keyId, request.headers.get('x-forwarded-for')) };
}

function baseHeaders(context: OpenDataContext): Record<string, string> {
  return {
    ...corsHeaders(),
    ...licenseHeaders(),
    // `limit: 0` marks an UNMETERED route (the dumps). Emitting
    // `RateLimit-Limit: 0` there would tell a client it has no budget at all,
    // which is the opposite of true — so an unmetered response carries no
    // rate-limit headers rather than misleading ones.
    ...(context.decision.limit > 0 ? rateLimitHeaders(context.decision) : {}),
  };
}

/**
 * The 429. Names the bulk dump, because "slow down" without "here is the whole
 * thing in one file" is advice a consumer cannot act on.
 */
export function tooManyRequests(context: OpenDataContext): Response {
  return Response.json(
    {
      error: 'rate_limited',
      message:
        'Rate limit exceeded. Retry after the window resets, or download the complete dataset instead — the nightly dumps are not rate limited.',
      retry_after_seconds: context.decision.retryAfterSeconds,
      dumps: absolute('/api/opendata/v1/dumps'),
      documentation: absolute('/danni'),
    },
    {
      status: 429,
      headers: {
        ...baseHeaders(context),
        'Retry-After': String(Math.max(context.decision.retryAfterSeconds, 1)),
        'Cache-Control': 'no-store',
      },
    },
  );
}

export function openDataJson(
  body: unknown,
  context: OpenDataContext,
  contentType = 'application/json; charset=utf-8',
): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      ...baseHeaders(context),
      'Content-Type': contentType,
      'Cache-Control': OPEN_DATA_CACHE,
    },
  });
}

export function openDataText(
  body: string,
  context: OpenDataContext,
  contentType: string,
  filename?: string,
): Response {
  return new Response(body, {
    headers: {
      ...baseHeaders(context),
      'Content-Type': contentType,
      'Cache-Control': OPEN_DATA_CACHE,
      ...(filename ? { 'Content-Disposition': `attachment; filename="${filename}"` } : {}),
    },
  });
}

export function openDataError(
  status: number,
  error: string,
  message: string,
  context: OpenDataContext,
): Response {
  return Response.json(
    { error, message, documentation: absolute('/danni') },
    { status, headers: { ...baseHeaders(context), 'Cache-Control': 'no-store' } },
  );
}

/** Preflight. Same headers, no body — nothing here is credentialed. */
export function openDataOptions(): Response {
  return new Response(null, { status: 204, headers: { ...corsHeaders(), ...licenseHeaders() } });
}

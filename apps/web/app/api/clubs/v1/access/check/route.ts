import { getDb } from '@sportkarta/db';

import { clientIpFromForwardedFor } from '@/lib/rate-limit';

import { clubsEnabled } from '@/lib/clubs/access';
import { apiError, apiJson, readJsonObject } from '@/lib/clubs/api';
import { checkDoorAccess, doorFromToken } from '@/lib/clubs/doors';
import { clubSwitchOn, featureOn } from '@/lib/clubs/features';
import { clubApiFailureLimiter, clubDoorLimiter } from '@/lib/clubs/rate-limit';

/**
 * POST /api/clubs/v1/access/check — a door or turnstile controller asks
 * whether to open (0057). `Authorization: Bearer skbd_…` (the door's own
 * token, never an API key), body `{ "credential": "<what the reader read>" }`
 * — a printed card's key or a member QR. The answer is always 200 with
 * `allow`; an allowed entry is already recorded as the visit (method 'door'),
 * a refused one recorded nothing. See apps/web/lib/clubs/doors.ts.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (!clubsEnabled() || !clubSwitchOn('api')) return apiError(404, 'not_found', 'Not found.');
  const match = /^Bearer\s+(\S+)$/i.exec((request.headers.get('authorization') ?? '').trim());
  // Only a failed token costs a slot, and doors have their own count — an API
  // integration misbehaving on the club's network never locks the turnstile.
  const ip = clientIpFromForwardedFor(request.headers.get('x-forwarded-for'));
  const failureKey = ip ? `door:${ip}` : null;
  if (failureKey) {
    const gate = clubApiFailureLimiter.wouldRefuse(failureKey);
    if (!gate.allowed) {
      return apiError(429, 'too_many_failures', 'Too many failed tokens. Wait and retry.', {
        'Retry-After': String(Math.ceil(gate.retryAfterMs / 1000)),
      });
    }
  }
  const door = match?.[1] ? await doorFromToken(match[1]) : null;
  if (!door) {
    if (failureKey) clubApiFailureLimiter.check(failureKey);
    return apiError(401, 'invalid_token', 'Unknown or revoked door token.', {
      'WWW-Authenticate': 'Bearer realm="pops"',
    });
  }
  if (!featureOn({ tier: door.tier }, 'door_access')) {
    return apiError(403, 'feature_not_in_plan', "The club's plan does not include door access.");
  }
  const budget = clubDoorLimiter.check(door.deviceId);
  if (!budget.allowed) {
    return apiError(429, 'rate_limited', 'Too many requests from this door. Wait and retry.', {
      'Retry-After': String(Math.ceil(budget.retryAfterMs / 1000)),
    });
  }
  const body = await readJsonObject(request, {});
  if (!body.ok) return body.response;
  const credential = body.value.credential;
  if (typeof credential !== 'string') {
    return apiError(400, 'invalid_field', 'credential is the text the reader read.');
  }
  const decision = await checkDoorAccess(getDb(), door, credential);
  if (!decision) return apiError(401, 'invalid_token', 'Unknown or revoked door token.');
  return apiJson(decision);
}

import {
  apiError,
  apiJson,
  authenticateClubApi,
  dayParam,
  daySpan,
  idempotently,
  outcomeError,
  readJsonObject,
  UUID_SHAPE,
} from '@/lib/clubs/api';
import { apiCheckin, apiCheckins, apiRecordCheckin } from '@/lib/clubs/api-data';

/**
 * GET  /api/clubs/v1/checkins?from=&to=  — visits on those Sofia days, at most
 *      31 (attendance:read)
 * POST /api/clubs/v1/checkins  — record a visit (attendance:write):
 *      `{ "member_id", "class_occurrence_id"?, "location_id"? }`. Recorded even
 *      when nothing covers it (`covered: false`) — attendance is never refused.
 */

export const dynamic = 'force-dynamic';

const MAX_DAYS = 31;

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateClubApi(request, { scope: 'attendance:read' });
  if (!auth.ok) return auth.response;
  const { key, headers } = auth.caller;
  const params = new URL(request.url).searchParams;
  const from = dayParam(params.get('from'));
  const to = dayParam(params.get('to'));
  if (!from || !to || daySpan(from, to) < 0 || daySpan(from, to) >= MAX_DAYS) {
    return apiError(
      400,
      'invalid_range',
      `from and to are YYYY-MM-DD, at most ${MAX_DAYS} days apart.`,
      headers,
    );
  }
  const { data, truncated } = await apiCheckins(key.actor, from, to);
  return apiJson({ data, from, to, truncated }, 200, headers);
}

function optionalUuid(value: unknown): string | null | 'invalid' {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && UUID_SHAPE.test(value) ? value : 'invalid';
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateClubApi(request, { scope: 'attendance:write' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  const body = await readJsonObject(request, caller.headers);
  if (!body.ok) return body.response;
  const memberId = body.value.member_id;
  const occurrenceId = optionalUuid(body.value.class_occurrence_id);
  const locationId = optionalUuid(body.value.location_id);
  if (
    typeof memberId !== 'string' ||
    !UUID_SHAPE.test(memberId) ||
    occurrenceId === 'invalid' ||
    locationId === 'invalid'
  ) {
    return apiError(
      400,
      'invalid_field',
      'member_id is a uuid; class_occurrence_id and location_id are uuids when given.',
      caller.headers,
    );
  }
  return idempotently(
    request,
    caller,
    body.raw,
    () => apiRecordCheckin(caller.key.actor, { memberId, occurrenceId, locationId }),
    async (outcome) => {
      if (outcome.errorCode || !outcome.resultId) return outcomeError(outcome, caller.headers);
      // The visit itself only to a key that may read it; otherwise its id.
      const checkin = caller.key.scopes.includes('attendance:read')
        ? await apiCheckin(caller.key.actor, outcome.resultId)
        : null;
      return apiJson({ data: checkin ?? { id: outcome.resultId } }, outcome.status, caller.headers);
    },
  );
}

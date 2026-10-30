import { sofiaToday } from '@sportkarta/lib/clubs';

import { apiError, apiJson, authenticateClubApi, dayParam, UUID_SHAPE } from '@/lib/clubs/api';
import { apiClasses } from '@/lib/clubs/api-data';

/**
 * GET /api/clubs/v1/classes?from=YYYY-MM-DD&days=7&location_id= — the class
 * dates starting in that Sofia window (schedule:read): at most 31 days, from
 * today by default.
 */

export const dynamic = 'force-dynamic';

const MAX_DAYS = 31;

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateClubApi(request, { scope: 'schedule:read' });
  if (!auth.ok) return auth.response;
  const { key, headers } = auth.caller;
  const params = new URL(request.url).searchParams;
  const from = params.has('from') ? dayParam(params.get('from')) : sofiaToday();
  const days = params.has('days') ? Number(params.get('days')) : 7;
  const location = params.get('location_id');
  if (!from || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return apiError(400, 'invalid_range', `from is YYYY-MM-DD; days is 1–${MAX_DAYS}.`, headers);
  }
  if (location !== null && !UUID_SHAPE.test(location)) {
    return apiError(400, 'invalid_location', 'location_id is a uuid.', headers);
  }
  const data = await apiClasses(key.actor, from, days, location);
  return apiJson({ data, from, days }, 200, headers);
}

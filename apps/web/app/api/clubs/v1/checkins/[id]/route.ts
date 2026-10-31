import { apiError, apiJson, authenticateClubApi, UUID_SHAPE } from '@/lib/clubs/api';
import { apiCheckin } from '@/lib/clubs/api-data';

/** GET /api/clubs/v1/checkins/{id} — one visit (attendance:read). */

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await authenticateClubApi(request, { scope: 'attendance:read' });
  if (!auth.ok) return auth.response;
  const { key, headers } = auth.caller;
  const { id } = await params;
  const checkin = UUID_SHAPE.test(id) ? await apiCheckin(key.actor, id) : null;
  if (!checkin) return apiError(404, 'not_found', 'No such visit at this club.', headers);
  return apiJson({ data: checkin }, 200, headers);
}

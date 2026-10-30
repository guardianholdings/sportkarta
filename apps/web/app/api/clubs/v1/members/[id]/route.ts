import { apiError, apiJson, authenticateClubApi, UUID_SHAPE } from '@/lib/clubs/api';
import { apiMember } from '@/lib/clubs/api-data';

/** GET /api/clubs/v1/members/{id} — one client record and its abonnements (members:read). */

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await authenticateClubApi(request, { scope: 'members:read' });
  if (!auth.ok) return auth.response;
  const { key, headers } = auth.caller;
  const { id } = await params;
  const member = UUID_SHAPE.test(id) ? await apiMember(key.actor, id) : null;
  if (!member) return apiError(404, 'not_found', 'No such record at this club.', headers);
  return apiJson({ data: member }, 200, headers);
}

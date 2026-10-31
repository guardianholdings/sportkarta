import { apiJson, authenticateClubApi } from '@/lib/clubs/api';

/**
 * GET /api/clubs/v1/club — who this key is: its club and scopes (0057). Any
 * live key may ask; the documentation's first call.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateClubApi(request, { scope: null });
  if (!auth.ok) return auth.response;
  const { key, headers } = auth.caller;
  return apiJson(
    { data: { club_id: key.clubId, slug: key.clubSlug, key_id: key.keyId, scopes: key.scopes } },
    200,
    headers,
  );
}

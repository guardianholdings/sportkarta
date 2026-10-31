import {
  apiJson,
  authenticateClubApi,
  idempotently,
  outcomeError,
  readJsonObject,
} from '@/lib/clubs/api';
import { apiCreateMember, apiListMembers, apiMember } from '@/lib/clubs/api-data';

/**
 * GET  /api/clubs/v1/members  — client records, 50 a page (members:read)
 * POST /api/clubs/v1/members  — a new client record (members:write), source 'api'
 *
 * The office's own list and form, through the key's creator (0057).
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateClubApi(request, { scope: 'members:read' });
  if (!auth.ok) return auth.response;
  const { key, headers } = auth.caller;
  const body = await apiListMembers(key.actor, new URL(request.url).searchParams);
  return apiJson(body, 200, headers);
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateClubApi(request, { scope: 'members:write' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  const body = await readJsonObject(request, caller.headers);
  if (!body.ok) return body.response;
  return idempotently(
    request,
    caller,
    body.raw,
    () => apiCreateMember(caller.key.actor, body.value),
    async (outcome) => {
      if (outcome.errorCode || !outcome.resultId) return outcomeError(outcome, caller.headers);
      // The record itself only to a key that may read it — a write-only key
      // (a website's lead form) learns the id, never the client's details.
      const member = caller.key.scopes.includes('members:read')
        ? await apiMember(caller.key.actor, outcome.resultId)
        : null;
      return apiJson({ data: member ?? { id: outcome.resultId } }, outcome.status, caller.headers);
    },
  );
}

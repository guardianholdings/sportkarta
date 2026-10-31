import {
  apiError,
  apiJson,
  authenticateClubApi,
  idempotently,
  outcomeError,
  UUID_SHAPE,
} from '@/lib/clubs/api';
import { apiBooking, apiCancelBooking } from '@/lib/clubs/api-data';

/**
 * GET    /api/clubs/v1/bookings/{id} — one booking (attendance:read)
 * DELETE /api/clubs/v1/bookings/{id} — cancel it, as the desk would
 *        (bookings:write): late inside the class's deadline, never once the
 *        class has started or the client has checked in.
 */

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const auth = await authenticateClubApi(request, { scope: 'attendance:read' });
  if (!auth.ok) return auth.response;
  const { key, headers } = auth.caller;
  const { id } = await params;
  const booking = UUID_SHAPE.test(id) ? await apiBooking(key.actor, id) : null;
  if (!booking) return apiError(404, 'not_found', 'No such booking at this club.', headers);
  return apiJson({ data: booking }, 200, headers);
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const auth = await authenticateClubApi(request, { scope: 'bookings:write' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  const { id } = await params;
  if (!UUID_SHAPE.test(id)) {
    return apiError(404, 'not_found', 'No such booking at this club.', caller.headers);
  }
  return idempotently(
    request,
    caller,
    '',
    () => apiCancelBooking(caller.key.actor, id),
    async (outcome) => {
      if (outcome.errorCode) return outcomeError(outcome, caller.headers);
      // The booking itself only to a key that may read it; otherwise its id.
      const booking = caller.key.scopes.includes('attendance:read')
        ? await apiBooking(caller.key.actor, id)
        : null;
      return apiJson({ data: booking ?? { id } }, outcome.status, caller.headers);
    },
  );
}

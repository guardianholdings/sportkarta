import {
  apiError,
  apiJson,
  authenticateClubApi,
  idempotently,
  outcomeError,
  readJsonObject,
  UUID_SHAPE,
} from '@/lib/clubs/api';
import { apiBook, apiBooking } from '@/lib/clubs/api-data';

/**
 * POST /api/clubs/v1/bookings — book a client onto a class date
 * (bookings:write): `{ "member_id", "class_occurrence_id" }`. A full class
 * puts them on the waiting list (`place: "waitlisted"`), as at the desk.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateClubApi(request, { scope: 'bookings:write' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  const body = await readJsonObject(request, caller.headers);
  if (!body.ok) return body.response;
  const memberId = body.value.member_id;
  const occurrenceId = body.value.class_occurrence_id;
  if (
    typeof memberId !== 'string' ||
    !UUID_SHAPE.test(memberId) ||
    typeof occurrenceId !== 'string' ||
    !UUID_SHAPE.test(occurrenceId)
  ) {
    return apiError(
      400,
      'invalid_field',
      'member_id and class_occurrence_id are uuids.',
      caller.headers,
    );
  }
  return idempotently(
    request,
    caller,
    body.raw,
    () => apiBook(caller.key.actor, occurrenceId, memberId),
    async (outcome) => {
      if (outcome.errorCode || !outcome.resultId) return outcomeError(outcome, caller.headers);
      // The booking itself only to a key that may read it; otherwise its id.
      const booking = caller.key.scopes.includes('attendance:read')
        ? await apiBooking(caller.key.actor, outcome.resultId)
        : null;
      return apiJson({ data: booking ?? { id: outcome.resultId } }, outcome.status, caller.headers);
    },
  );
}

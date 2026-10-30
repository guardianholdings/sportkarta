import { apiError, apiJson, authenticateClubApi } from '@/lib/clubs/api';
import { apiPayment } from '@/lib/clubs/api-data';

/** GET /api/clubs/v1/payments/{id} — one payment or refund (payments:read). */

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await authenticateClubApi(request, { scope: 'payments:read' });
  if (!auth.ok) return auth.response;
  const { key, headers } = auth.caller;
  const { id } = await params;
  const payment = await apiPayment(key.actor, id);
  if (!payment) return apiError(404, 'not_found', 'No such payment at this club.', headers);
  return apiJson({ data: payment }, 200, headers);
}

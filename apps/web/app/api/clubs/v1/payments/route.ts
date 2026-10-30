import { apiError, apiJson, authenticateClubApi, dayParam, daySpan } from '@/lib/clubs/api';
import { apiPayments } from '@/lib/clubs/api-data';

/**
 * GET /api/clubs/v1/payments?from=&to= — payments and refunds received on
 * those days, at most 31 (payments:read). Amounts in euro cents; a refund is
 * negative.
 */

export const dynamic = 'force-dynamic';

const MAX_DAYS = 31;

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateClubApi(request, { scope: 'payments:read' });
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
  const { data, truncated } = await apiPayments(key.actor, from, to);
  return apiJson({ data, from, to, truncated }, 200, headers);
}

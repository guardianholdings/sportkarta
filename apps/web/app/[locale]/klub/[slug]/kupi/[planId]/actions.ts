'use server';

import { getDb } from '@sportkarta/db';
import { isIsoDate } from '@sportkarta/lib/clubs';
import { getLocale } from 'next-intl/server';
import { redirect as redirectOut } from 'next/navigation';

import { redirect } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { isUuid } from '@/lib/clubs/input';
import { checkoutReturn, startPlanCheckout } from '@/lib/clubs/payments';
import { clubIdForSlug } from '@/lib/clubs/portal';
import { clubMemberActionLimiter } from '@/lib/clubs/rate-limit';

/**
 * «Към плащане» on a public plan. startPlanCheckout re-checks everything in
 * SQL — the plan is public and live, the record is this account's own or a
 * child under it, the audience fits — and creates nothing but the checkout:
 * the membership exists only once the provider confirms the money.
 */

function str(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

export async function buyPlanAction(formData: FormData): Promise<void> {
  requireClubsEnabled();
  const user = await requireUser();
  const locale = await getLocale();
  const slug = str(formData, 'slug');
  const planId = str(formData, 'planId');
  const clubId = await clubIdForSlug(slug);
  if (!clubId || !isUuid(planId)) return;
  const back = (rezultat: string) =>
    redirect({ href: { pathname: `/klub/${slug}/kupi/${planId}`, query: { rezultat } }, locale });
  if (!clubMemberActionLimiter.check(`buy:${user.id}`).allowed) return back('rate_limited');
  const forMember = str(formData, 'memberId');
  const startsOn = str(formData, 'startsOn');
  const started = await startPlanCheckout(
    getDb(),
    user.id,
    { id: clubId, slug },
    {
      planId,
      memberId: isUuid(forMember) ? forMember : null,
      startsOn: isIsoDate(startsOn) ? startsOn : null,
      // Whether the club HAS terms is decided in the statement, never by a
      // hidden field the browser could drop.
      termsAccepted: str(formData, 'terms') === '1',
    },
    checkoutReturn(locale),
  );
  if (!started.ok) return back(started.error);
  return redirectOut(started.url);
}

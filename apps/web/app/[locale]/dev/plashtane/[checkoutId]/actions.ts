'use server';

import { getLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { redirect } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { isUuid } from '@/lib/clubs/input';
import { checkoutForMember, fakeSettle, paymentProvider } from '@/lib/clubs/payments';
import { clubIdForSlug } from '@/lib/clubs/portal';

/**
 * The fake provider's two buttons. Development only: fakeSettle refuses
 * unless PAYMENT_PROVIDER resolves to `fake`, which it never does in a
 * production build. The checkout must be the signed-in account's own (or a
 * child's), exactly as on the return page.
 */
export async function fakePayAction(formData: FormData): Promise<void> {
  if (process.env.NODE_ENV === 'production' || paymentProvider() !== 'fake') notFound();
  const user = await requireUser();
  const locale = await getLocale();
  const checkoutId = formData.get('checkoutId');
  const slug = formData.get('slug');
  const outcome = formData.get('outcome') === 'paid' ? 'paid' : 'cancelled';
  if (!isUuid(checkoutId) || typeof slug !== 'string') notFound();
  const clubId = await clubIdForSlug(slug);
  if (!clubId || !(await checkoutForMember(user.id, clubId, checkoutId))) notFound();
  await fakeSettle(checkoutId, outcome);
  return outcome === 'paid'
    ? redirect({ href: `/klub/${slug}/az/plashtane/${checkoutId}`, locale })
    : redirect({
        href: { pathname: `/klub/${slug}/az`, query: { rezultat: 'payment_cancelled' } },
        locale,
      });
}

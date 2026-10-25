import { getDb, sql } from '@sportkarta/db';
import { formatEuro } from '@sportkarta/lib/clubs';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { requireUser } from '@/lib/auth-session';
import { isUuid } from '@/lib/clubs/input';
import { checkoutForMember, paymentProvider } from '@/lib/clubs/payments';

import { fakePayAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Dev-only stand-in for Stripe's hosted Checkout page (the fake provider,
 * like /dev/poshta stands in for an inbox). «Pay» settles the checkout through
 * the same applyCheckoutPaid the worker runs after a real Stripe event;
 * «Cancel» lets it lapse. Never a production surface: a production build 404s
 * here and the fake provider cannot resolve there anyway. Plain English on
 * purpose — no member ever sees it, and it stays out of the catalogues.
 */
export default async function FakeCheckoutPage({
  params,
}: {
  params: Promise<{ locale: string; checkoutId: string }>;
}) {
  const { locale, checkoutId } = await params;
  setRequestLocale(locale);
  if (process.env.NODE_ENV === 'production' || paymentProvider() !== 'fake') notFound();
  if (!isUuid(checkoutId)) notFound();
  const user = await requireUser();
  const row = (
    await getDb().execute(sql`
      SELECT k.club_id, c.slug FROM club_checkouts k JOIN clubs c ON c.id = k.club_id
       WHERE k.id = ${checkoutId}::uuid AND k.provider = 'fake'
    `)
  ).rows[0];
  if (!row) notFound();
  const checkout = await checkoutForMember(user.id, String(row.club_id), checkoutId);
  if (!checkout) notFound();
  const slug = String(row.slug);
  const button =
    'inline-flex min-h-11 items-center rounded-pill border border-line-strong bg-surface px-4 text-body-sm font-semibold text-ink hover:bg-surface-2';

  return (
    <main className="mx-auto max-w-md space-y-4 p-6">
      <p className="text-caption font-semibold uppercase tracking-wide text-text-muted">
        Test payment (dev)
      </p>
      <p className="font-mono text-h2 tabular-nums text-ink">
        {formatEuro(checkout.amountCents, locale)}
      </p>
      <p className="text-body-sm text-ink-soft">
        {checkout.purpose} · {checkout.status}
      </p>
      {checkout.status === 'open' && (
        <div className="flex gap-2">
          {(['paid', 'cancelled'] as const).map((outcome) => (
            <form key={outcome} action={fakePayAction}>
              <input type="hidden" name="checkoutId" value={checkoutId} />
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="outcome" value={outcome} />
              <button type="submit" className={button}>
                {outcome === 'paid' ? 'Pay' : 'Cancel'}
              </button>
            </form>
          ))}
        </div>
      )}
    </main>
  );
}

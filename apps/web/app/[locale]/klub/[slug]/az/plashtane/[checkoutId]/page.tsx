import { formatEuro } from '@sportkarta/lib/clubs';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { AppShell } from '@/components/shell/app-shell';
import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { isUuid } from '@/lib/clubs/input';
import { checkoutForMember } from '@/lib/clubs/payments';
import { clubIdForSlug } from '@/lib/clubs/portal';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/** How often the page looks again while the provider's confirmation is on its way. */
const REFRESH_SECONDS = 3;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubPurchase' });
  return { title: t('returnTitle'), robots: { index: false, follow: false } };
}

/**
 * Where Stripe sends the member back. Coming back proves nothing — the money
 * is recorded only when the provider's own event arrives (the webhook, then
 * the worker re-fetching the session) — so while the checkout is still open
 * the page refreshes itself with a meta refresh: no script.
 */
export default async function CheckoutReturnPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string; checkoutId: string }>;
}) {
  const { locale, slug, checkoutId } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  const user = await requireUser();
  if (!isUuid(checkoutId)) notFound();
  const clubId = await clubIdForSlug(slug);
  if (!clubId) notFound();
  const checkout = await checkoutForMember(user.id, clubId, checkoutId);
  if (!checkout) notFound();
  const t = await getTranslations('ClubPurchase');
  const amount = formatEuro(checkout.amountCents, locale);
  const tone =
    checkout.status === 'paid'
      ? 'border-success-border bg-success-bg'
      : checkout.status === 'expired'
        ? 'border-warning-border bg-warning-bg'
        : 'border-line bg-surface';

  return (
    <AppShell active={null}>
      {checkout.status === 'open' && <meta httpEquiv="refresh" content={String(REFRESH_SECONDS)} />}
      <main className="mx-auto max-w-md space-y-4 p-4">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('returnTitle')}</h1>
        <p
          role="status"
          aria-live="polite"
          className={cn('rounded-card border p-4 text-body text-ink', tone)}
        >
          {t(`status.${checkout.status}`, { amount })}
        </p>
        <Link href={`/klub/${slug}/az`} className={buttonVariants({ variant: 'secondary' })}>
          {t('toPortal')}
        </Link>
      </main>
    </AppShell>
  );
}

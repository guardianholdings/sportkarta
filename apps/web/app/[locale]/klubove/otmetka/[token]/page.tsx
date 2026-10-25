import { verifyClubToken } from '@sportkarta/lib/checkin-token';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { getCurrentUser } from '@/lib/auth-session';
import { checkinSecret } from '@/lib/checkin-config';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { kioskLocation } from '@/lib/clubs/kiosk';
import { signInHref } from '@/lib/sign-in-destination';

import { redeemKioskAction } from './actions';

/**
 * Where a member's phone lands after scanning the club tablet. Verified here
 * so an expired code says so BEFORE the member presses anything; verified
 * again in the action. One message for every failure: a member cannot act on
 * "expired" versus "forged", and an attacker should not learn the difference.
 * No geolocation — being in front of the tablet IS the proximity proof.
 *
 * noindex: the URL is valid for two minutes.
 */
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; token: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubKiosk.redeem' });
  return { title: t('title'), robots: { index: false, follow: false } };
}

export default async function ClubRedeemPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  const { rezultat } = await searchParams;
  const t = await getTranslations('ClubKiosk');
  const secret = checkinSecret();
  const verified = secret ? verifyClubToken(token, secret, 'loc') : null;
  const location = verified?.ok ? await kioskLocation(verified.id, locale) : null;

  if (!secret) {
    return (
      <main className="mx-auto max-w-md space-y-4 p-4">
        <p role="alert">{t('disabled')}</p>
      </main>
    );
  }

  if (!location || rezultat === 'invalid') {
    return (
      <main className="mx-auto max-w-md space-y-4 p-4">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('redeem.title')}</h1>
        <p className="text-ink-soft">{t('redeem.invalid')}</p>
      </main>
    );
  }

  const user = await getCurrentUser();
  return (
    <main className="mx-auto max-w-md space-y-4 p-4">
      <header className="space-y-1">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{location.clubName}</h1>
        <p className="text-body-sm text-text-muted">{location.locationName}</p>
      </header>
      <div role="status" aria-live="polite">
        {rezultat === 'rate_limited' && (
          <p className="rounded-card border border-warning-border bg-warning-bg p-3 text-body-sm text-ink">
            {t('redeem.rateLimited')}
          </p>
        )}
      </div>
      {user ? (
        <form action={redeemKioskAction}>
          <input type="hidden" name="token" value={token} />
          <Button type="submit" block className="min-h-12 text-body">
            {t('redeem.confirm')}
          </Button>
        </form>
      ) : (
        <>
          <p className="text-ink-soft">{t('redeem.signIn')}</p>
          <Link
            href={signInHref(`/klubove/otmetka/${token}`)}
            className="font-semibold text-link hover:text-link-hover"
          >
            {t('redeem.signInLink')}
          </Link>
        </>
      )}
    </main>
  );
}

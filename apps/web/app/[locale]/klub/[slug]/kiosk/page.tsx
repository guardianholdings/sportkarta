import { issueClubToken, msUntilNextWindow } from '@sportkarta/lib/checkin-token';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { cookies } from 'next/headers';
import QRCode from 'qrcode';

import { PopsMark } from '@/components/shell/pops-mark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { checkinSecret } from '@/lib/checkin-config';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { KIOSK_COOKIE, kioskFromCookie, kioskTodayCount } from '@/lib/clubs/kiosk';
import { siteUrl } from '@/lib/seo';

import { pairKioskAction } from './actions';

/**
 * The tablet at the club's desk. Two states:
 *
 *  - not paired: a 6-digit code form. The code comes from a manager in
 *    Settings → Kiosk; the tablet never holds a staff session.
 *  - paired: the club's name, one instruction and a QR naming this LOCATION
 *    (`v2~loc` token, rotating every minute). A member's phone opens it,
 *    signs in if needed, and their account — not the tablet — says who they
 *    are. Nothing personal is ever on this screen: a count, never a name.
 *
 * Same envelope as the session QR screen: server-rendered SVG, a meta refresh
 * timed to the window end, no client JavaScript, no shell.
 */
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; slug: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubKiosk' });
  return { title: t('title'), robots: { index: false, follow: false } };
}

export default async function ClubKioskPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  const { rezultat } = await searchParams;
  const t = await getTranslations('ClubKiosk');
  const cookie = (await cookies()).get(KIOSK_COOKIE)?.value;
  const session = /^[a-z0-9-]{3,60}$/.test(slug) ? await kioskFromCookie(slug, cookie) : null;

  if (!session) {
    const message =
      rezultat === 'bad_code'
        ? t('badCode')
        : rezultat === 'rate_limited'
          ? t('rateLimited')
          : cookie
            ? t('unpaired')
            : null;
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 p-6">
        <span className="text-accent">
          <PopsMark size={40} />
        </span>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('pairTitle')}</h1>
        <p className="text-body-sm text-ink-soft">{t('pairIntro')}</p>
        <div role="status" aria-live="polite">
          {message && (
            <p className="rounded-card border border-warning-border bg-warning-bg p-3 text-body-sm text-ink">
              {message}
            </p>
          )}
        </div>
        <form action={pairKioskAction} className="space-y-3">
          <input type="hidden" name="slug" value={slug} />
          <label className="block text-body-sm font-semibold text-ink">
            {t('code')}
            <Input
              name="code"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,8}"
              maxLength={8}
              className="mt-1 text-center font-mono text-h3 tracking-[0.3em]"
            />
          </label>
          <Button type="submit" block>
            {t('pair')}
          </Button>
        </form>
      </main>
    );
  }

  const secret = checkinSecret();
  const blocked = !session.live ? t('closed') : !secret ? t('disabled') : null;
  if (blocked || !secret) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-6 text-center">
        <meta httpEquiv="refresh" content="300" />
        <h1 className="text-h1 font-extrabold tracking-tight text-ink">{session.clubName}</h1>
        <p
          role="status"
          className="max-w-md rounded-card border border-warning-border bg-warning-bg p-4 text-body text-ink"
        >
          {blocked}
        </p>
      </main>
    );
  }

  const now = new Date();
  const token = issueClubToken({ kind: 'loc', id: session.locationId, secret, at: now });
  const url = `${siteUrl().replace(/\/+$/, '')}/klubove/otmetka/${token}`;
  // The string comes from the qrcode library encoding a URL built from our own
  // site base and our own HMAC over a database uuid — no user input reaches it.
  const svg = await QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 360,
  });
  const refreshSeconds = Math.ceil(msUntilNextWindow(now) / 1000) + 1;
  const count = await kioskTodayCount(session);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-surface p-6 text-center">
      <meta httpEquiv="refresh" content={String(refreshSeconds)} />
      <header className="space-y-1">
        <h1 className="text-h1 font-extrabold tracking-tight text-ink">{session.clubName}</h1>
        <p className="text-body text-ink-soft">{session.locationName}</p>
      </header>
      <p className="text-h3 font-bold text-ink">{t('scan')}</p>
      <div
        className="w-full max-w-[360px] rounded-card bg-surface p-3"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <p className="max-w-md text-body-sm text-ink-soft">{t('scanHint')}</p>
      <p className="text-h4 font-semibold tabular-nums text-ink">{t('today', { count })}</p>
      <p className="text-caption text-text-muted">{t('rotates')}</p>
      <span className="text-accent">
        <PopsMark size={32} />
      </span>
    </main>
  );
}

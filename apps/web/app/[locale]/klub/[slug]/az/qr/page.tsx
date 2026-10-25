import { issueClubToken, msUntilNextWindow } from '@sportkarta/lib/checkin-token';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import QRCode from 'qrcode';

import { Link } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { checkinSecret } from '@/lib/checkin-config';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { isUuid } from '@/lib/clubs/input';
import { portalView } from '@/lib/clubs/portal';
import { siteUrl } from '@/lib/seo';

/**
 * A member's personal QR for the desk (`v2~mem~<club_members.id>`). It names
 * the CLUB RECORD, never the POPS account, so the club learns nothing it does
 * not already hold, and a screenshot is useless after two minutes. A guardian
 * shows a child's code from here (`?za=` must be a record the portal view
 * admits). Server-rendered SVG with a meta refresh — the session QR envelope.
 */
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; slug: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubPortal' });
  return { title: t('qrTitle'), robots: { index: false, follow: false } };
}

export default async function ClubMemberQrPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: Promise<{ za?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  const user = await requireUser();
  const view = await portalView(user.id, slug, locale);
  if (!view || view.link?.status !== 'active') notFound();
  const { za } = await searchParams;
  const record =
    (isUuid(za) ? view.records.find((r) => r.memberId === za) : undefined) ??
    view.records.find((r) => r.self);
  if (!record) notFound();
  const t = await getTranslations('ClubPortal');
  const tKiosk = await getTranslations('ClubKiosk');
  const secret = checkinSecret();

  if (!secret) {
    return (
      <main className="mx-auto max-w-md space-y-4 p-4">
        <p role="alert">{tKiosk('disabled')}</p>
      </main>
    );
  }

  const now = new Date();
  const token = issueClubToken({ kind: 'mem', id: record.memberId, secret, at: now });
  const url = `${siteUrl().replace(/\/+$/, '')}/klub/${view.club.slug}/skan/${token}`;
  // Our own site base and our own HMAC over a database uuid — no user input
  // reaches the markup.
  const svg = await QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
  });
  const refreshSeconds = Math.ceil(msUntilNextWindow(now) / 1000) + 1;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-4 text-center">
      <meta httpEquiv="refresh" content={String(refreshSeconds)} />
      <header className="space-y-1">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{view.club.name}</h1>
        <p className="text-body font-semibold text-ink">{record.displayName}</p>
      </header>
      <div
        className="w-full max-w-[320px] rounded-card bg-surface p-3"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <p className="text-body-sm text-ink-soft">{t('qrIntro')}</p>
      <p className="text-caption text-text-muted">{t('qrRotates')}</p>
      <Link
        href={`/klub/${slug}/az`}
        className="text-body-sm font-semibold text-link hover:text-link-hover"
      >
        ← {t('overline')}
      </Link>
    </main>
  );
}

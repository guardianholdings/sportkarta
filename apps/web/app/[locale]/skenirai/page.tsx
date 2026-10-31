import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { QrScanner } from '@/components/checkin/qr-scanner';
import { AppShell } from '@/components/shell/app-shell';
import { requireUser } from '@/lib/auth-session';
import { siteUrl } from '@/lib/seo';

/**
 * «Сканирай QR за присъствие», the third action of the «+» (UX audit N3).
 * Checking in used to need the phone's own camera app, and a signed-out scan
 * spent the code's two minutes on the sign-in page. Here the member signs in
 * FIRST (middleware: /skenirai is protected) and scans after, so the code is
 * fresh when it is read; the scanner opens only a POPS check-in link
 * (lib/scan-target.ts).
 */

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Scan' });
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

export default async function ScanPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireUser();
  const t = await getTranslations('Scan');

  return (
    <AppShell>
      <main className="mx-auto max-w-md px-4 py-5">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1.5 text-body-sm text-ink-soft">{t('intro')}</p>
        <div className="mt-5">
          <QrScanner siteOrigin={new URL(siteUrl()).origin} />
        </div>
        <p className="mt-4 text-caption text-text-muted">{t('privacy')}</p>
      </main>
    </AppShell>
  );
}

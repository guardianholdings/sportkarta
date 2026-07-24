import type { Metadata, Viewport } from 'next';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { UmamiAnalytics } from '@/components/analytics/umami';
import { ErrorMonitor } from '@/components/monitoring/error-monitor';
import { ServiceWorkerRegistrar } from '@/components/pwa/service-worker';
import { SiteFooter } from '@/components/shell/site-footer';
import { routing } from '@/i18n/routing';

import '../fonts.css';
import '../globals.css';

type LocaleParams = Promise<{ locale: string }>;

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export const viewport: Viewport = {
  themeColor: '#0f766e',
};

export async function generateMetadata({ params }: { params: LocaleParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Metadata' });

  return {
    title: t('title'),
    description: t('description'),
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: LocaleParams;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  // Read at request time (non-public names so container env applies without a
  // rebuild). Empty/unset disables the feature.
  const umamiSrc = process.env.UMAMI_SRC;
  const umamiWebsiteId = process.env.UMAMI_WEBSITE_ID;
  const glitchtipDsn = process.env.GLITCHTIP_DSN;

  return (
    <html lang={locale}>
      <body className="antialiased">
        <NextIntlClientProvider>
          {children}
          <SiteFooter />
        </NextIntlClientProvider>
        <ServiceWorkerRegistrar />
        {umamiSrc && umamiWebsiteId ? (
          <UmamiAnalytics src={umamiSrc} websiteId={umamiWebsiteId} />
        ) : null}
        {glitchtipDsn ? <ErrorMonitor dsn={glitchtipDsn} /> : null}
      </body>
    </html>
  );
}

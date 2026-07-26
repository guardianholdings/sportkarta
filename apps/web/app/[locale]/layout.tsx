import type { Metadata, Viewport } from 'next';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { UmamiAnalytics } from '@/components/analytics/umami';
import { ErrorMonitor } from '@/components/monitoring/error-monitor';
import { ServiceWorkerRegistrar } from '@/components/pwa/service-worker';
import { SiteFooter } from '@/components/shell/site-footer';
import { routing } from '@/i18n/routing';
import { siteUrl } from '@/lib/seo';

import '../fonts.css';
import '../globals.css';

type LocaleParams = Promise<{ locale: string }>;

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export const viewport: Viewport = {
  // Brand pine, = --brand / --pine-600 in app/design-tokens/colors.css. Was the
  // pre-seed shadcn teal #0f766e until 2026-07-26, which appears nowhere in the
  // Trail & Summit palette — RECONCILIATION.md C6 called for this and it was
  // never applied, so every themed browser and every installed PWA framed a
  // pine-and-clay page in teal chrome. Neither this file nor app/manifest.ts is
  // inside the design-token gate's scanned dirs, which is how it survived; the
  // drift is now pinned by tests/theme-color-drift.test.ts instead.
  themeColor: '#216543',
};

export async function generateMetadata({ params }: { params: LocaleParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Metadata' });

  return {
    // Without metadataBase Next cannot resolve a RELATIVE openGraph.images path
    // to an absolute URL, and every card would build cleanly and then render
    // nothing in any preview — the failure costs a share and reports nothing.
    // lib/seo.ts already owns the origin; this is the same source the canonical
    // and hreflang tags use, so a card cannot point at a different host.
    metadataBase: new URL(siteUrl()),
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

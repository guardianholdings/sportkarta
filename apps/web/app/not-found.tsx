import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

import { PopsMark } from '@/components/shell/pops-mark';
import { routing } from '@/i18n/routing';

import './fonts.css';
import './globals.css';

/**
 * Root «not found» — reached only when the first path segment is not a locale
 * and the request never passed through the i18n middleware (it skips any path
 * with a dot, which is what scanners probe: /wp-login.php, /.env). Every
 * ordinary unmatched path is caught inside the locale instead, by
 * [locale]/[...rest], and gets the full localized page.
 *
 * No locale can be known here, so it speaks the default one — Bulgarian-first,
 * like "/" — and renders its own document, because the root layout is a
 * pass-through. The link is next/link, not the locale-aware one: there is no
 * intl provider above this file for that one to read, and "/" is the
 * Bulgarian map without any prefix.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: routing.defaultLocale, namespace: 'NotFound' });
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

export default async function RootNotFound() {
  const t = await getTranslations({ locale: routing.defaultLocale, namespace: 'NotFound' });
  return (
    <html lang={routing.defaultLocale}>
      <body className="antialiased">
        <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-start justify-center gap-5 px-4 py-12">
          <PopsMark size={56} className="text-accent" />
          <div className="space-y-3">
            <p className="font-mono text-caption font-semibold uppercase tracking-overline text-text-muted">
              {t('code')}
            </p>
            <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
            <p className="text-ink-soft">{t('body')}</p>
          </div>
          <Link
            href="/"
            className="inline-flex min-h-11 items-center rounded-pill bg-brand px-5 text-body-sm font-semibold text-on-brand shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-brand-hover"
          >
            {t('toMap')}
          </Link>
        </main>
      </body>
    </html>
  );
}

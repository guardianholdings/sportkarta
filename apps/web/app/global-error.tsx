'use client';

import { createTranslator } from 'next-intl';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import { reportCaughtError } from '@/components/monitoring/report-caught-error';
import { PopsMark } from '@/components/shell/pops-mark';
import { routing } from '@/i18n/routing';

import bg from '@/messages/bg.json';
import en from '@/messages/en.json';

import './fonts.css';
import './globals.css';

/**
 * Last-resort error screen: shown only when app/[locale]/layout.tsx itself
 * fails, so it replaces the WHOLE document and must render its own <html> and
 * <body>. Every page-level failure is caught earlier by [locale]/error.tsx,
 * inside the layout, with the navigation around it.
 *
 * There is no intl provider here — it lived in the layout that just failed —
 * so the locale is read from the URL (the English site is the /en prefix;
 * everything else is the default, Bulgarian) and the strings come straight
 * from the catalogue through next-intl's standalone translator. Only the
 * ErrorPage namespace is read, which is what lets the bundler drop the rest
 * of both catalogues from this always-loaded chunk.
 *
 * Retry is a full reload rather than `reset()`: what broke is the root layout,
 * and a fresh document is the one retry that re-runs all of it.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const pathname = usePathname() ?? '';
  useEffect(() => {
    reportCaughtError(error);
  }, [error]);
  const locale = /^\/en(\/|$)/.test(pathname) ? 'en' : routing.defaultLocale;
  const t = createTranslator({
    locale,
    messages: { ErrorPage: locale === 'en' ? en.ErrorPage : bg.ErrorPage },
    namespace: 'ErrorPage',
  });

  return (
    <html lang={locale}>
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
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex min-h-11 items-center rounded-pill bg-brand px-5 text-body-sm font-semibold text-on-brand shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-brand-hover"
            >
              {t('retry')}
            </button>
            <a
              href={locale === 'en' ? '/en' : '/'}
              className="inline-flex min-h-11 items-center rounded-pill border border-line-strong bg-surface px-5 text-body-sm font-semibold text-ink shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-surface-2"
            >
              {t('toMap')}
            </a>
          </div>
          {error.digest ? (
            <p className="font-mono text-caption text-text-muted">
              {t('reference', { digest: error.digest })}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}

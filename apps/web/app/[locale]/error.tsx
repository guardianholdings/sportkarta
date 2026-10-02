'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useTransition } from 'react';

import { reportCaughtError } from '@/components/monitoring/report-caught-error';
import { BottomNav, NavRail } from '@/components/shell/app-nav';
import { PopsMark } from '@/components/shell/pops-mark';
import { Link } from '@/i18n/navigation';

/**
 * The error boundary for every page under a locale. Before it existed, a
 * database hiccup, a deploy landing mid-session or a photo over the server
 * action body limit replaced the whole screen with Next's English
 * "Application error" and no way forward.
 *
 * It renders inside [locale]/layout.tsx, so translations are available — but
 * it must be a client component, and AppShell is an async server component.
 * The shell is therefore composed here from NavRail/BottomNav directly, which
 * are pure precisely so the map's client explorer can do the same.
 *
 * RETRY re-runs the server render. `reset()` alone only re-renders the client
 * tree, which re-throws the same cached server error; `router.refresh()` inside
 * the same transition fetches a fresh payload first (the pattern Next documents
 * for server-component errors).
 *
 * The digest is shown because it is the one thing a visitor can quote that
 * lets the operator find the server log line. It is a hash — never the message,
 * which in development could contain anything. The error itself goes to
 * GlitchTip, which a caught error would otherwise never reach.
 */
export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('ErrorPage');
  const tNav = useTranslations('Nav');
  const router = useRouter();
  const [retrying, startRetry] = useTransition();

  useEffect(() => {
    reportCaughtError(error);
  }, [error]);

  const retry = () => {
    startRetry(() => {
      router.refresh();
      reset();
    });
  };

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <NavRail labelFor={(k) => tNav(k)} className="sticky top-0 hidden h-dvh lg:flex" />
      <div className="flex min-w-0 flex-1 flex-col">
        <main
          id="main-content"
          className="mx-auto flex w-full max-w-xl flex-1 flex-col items-start gap-5 px-4 py-12 pb-9 sm:py-16 lg:pb-16"
        >
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
              onClick={retry}
              disabled={retrying}
              className="inline-flex min-h-11 items-center rounded-pill bg-brand px-5 text-body-sm font-semibold text-on-brand shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-brand-hover disabled:opacity-50"
            >
              {t('retry')}
            </button>
            <Link
              href="/"
              className="inline-flex min-h-11 items-center rounded-pill border border-line-strong bg-surface px-5 text-body-sm font-semibold text-ink shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-surface-2"
            >
              {t('toMap')}
            </Link>
          </div>
          {error.digest ? (
            <p className="font-mono text-caption text-text-muted">
              {t('reference', { digest: error.digest })}
            </p>
          ) : null}
        </main>
        <BottomNav labelFor={(k) => tNav(k)} className="sticky bottom-0 z-40 lg:hidden" />
      </div>
    </div>
  );
}

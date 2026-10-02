import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AppShell } from '@/components/shell/app-shell';
import { PopsMark } from '@/components/shell/pops-mark';
import { Link } from '@/i18n/navigation';

/**
 * The localized «not found» page for every route under a locale: a facility
 * that was removed or hidden, an expired session link, a withdrawn public
 * passport, a draft campaign, an unknown city — and, through the catch-all in
 * [...rest], any path that matches nothing at all.
 *
 * INSIDE THE APP SHELL on purpose. The people who land here followed a shared
 * or stale link, so this is often their first screen of the product; Next's
 * default was an English sentence in an empty viewport with the way back
 * pushed below the fold. Here the nav rail / tab bar are present, and the two
 * exits are the two things a visitor most likely came for: the map, and what is
 * being played this week.
 *
 * Whether the response is a REAL 404 is decided elsewhere — by keeping loading
 * boundaries off every segment that can call notFound() (see
 * components/shell/route-loading.tsx). This file only decides what it looks
 * like, and it renders the same whichever status the response carries.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('NotFound');
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

export default async function LocaleNotFound() {
  const t = await getTranslations('NotFound');
  return (
    <AppShell>
      <main className="mx-auto flex max-w-xl flex-col items-start gap-5 px-4 py-12 sm:py-16">
        <PopsMark size={56} className="text-accent" />
        <div className="space-y-3">
          <p className="font-mono text-caption font-semibold uppercase tracking-overline text-text-muted">
            {t('code')}
          </p>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
          <p className="text-ink-soft">{t('body')}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center rounded-pill bg-brand px-5 text-body-sm font-semibold text-on-brand shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-brand-hover"
          >
            {t('toMap')}
          </Link>
          <Link
            href="/sesii"
            className="inline-flex min-h-11 items-center rounded-pill border border-line-strong bg-surface px-5 text-body-sm font-semibold text-ink shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-surface-2"
          >
            {t('toSessions')}
          </Link>
        </div>
      </main>
    </AppShell>
  );
}

import { getDb } from '@sportkarta/db';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { BadgeGrid } from '@/components/passport/badge-grid';
import { HistoryList } from '@/components/passport/history-list';
import { StreakPanel } from '@/components/passport/streak-panel';
import { ShareSheet } from '@/components/share/share-sheet';
import { buildShare } from '@sportkarta/lib/share';

import { WeekShare } from '@/components/share/week-share';
import { renderWeekGrid } from '@/lib/share/week-grid';
import { VisibilityPanel } from '@/components/passport/visibility-panel';
import { requireUser } from '@/lib/auth-session';
import { ownPassport } from '@/lib/passport';
import { siteUrl } from '@/lib/seo';
import { Link } from '@/i18n/navigation';

import { acknowledgeBadgesAction } from './actions';
import { AppShell } from '@/components/shell/app-shell';
import { shareSheetStrings } from '@/lib/share/sheet-strings';

/**
 * The member's own sports passport (docs/ROADMAP.md §7, Stage 5.1).
 *
 * noindex, and not in the sitemap: a personal page is not programmatic SEO
 * surface, and this one is behind a session anyway. force-dynamic because
 * badges are evaluated from live history on every read — that is what makes a
 * newly-added badge appear retroactively rather than after a cache expiry.
 */
export const metadata = { robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function PassportPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, tShare, tShare2, sheetPassport] = await Promise.all([
    getTranslations('Passport'),
    getTranslations('Share'),
    getTranslations('ShareSheet'),
    shareSheetStrings('passport'),
  ]);
  const user = await requireUser();
  const passport = await ownPassport(getDb(), user.id);

  const publicUrl = passport.visibility.isPublic && passport.visibility.handle
    ? `${siteUrl()}/pasport/${passport.visibility.handle}`
    : null;

  const totals = [
    { key: 'points', value: passport.totals.points },
    { key: 'facilitiesAdded', value: passport.totals.facilitiesAdded },
    { key: 'facilitiesVerified', value: passport.totals.facilitiesVerified },
    { key: 'conditionsReported', value: passport.totals.conditionsReported },
    { key: 'checkins', value: passport.totals.checkins },
  ] as const;

  return (
    <AppShell active="/profil">
      <main className="mx-auto max-w-2xl space-y-10 p-4">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line pb-3">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <div className="ml-auto flex items-center gap-3 text-caption">
          <Link href="/klasirane" className="font-medium text-link hover:text-link-hover">
            {t('leaderboardLink')}
          </Link>
          <Link href="/profil" className="font-medium text-link hover:text-link-hover">
            {t('profileLink')}
          </Link>
        </div>
      </header>

      <section aria-labelledby="totals-h" className="space-y-3">
        <h2 id="totals-h" className="text-h4 font-bold text-ink">
          {t('totalsTitle')}
        </h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {totals.map((total) => (
            <div key={total.key} className="rounded-card border border-line bg-surface p-3 shadow-sm">
              <dt className="text-caption text-text-muted">{t(`total_${total.key}`)}</dt>
              <dd className="mt-1 font-mono text-h3 font-bold text-ink tabular-nums">{total.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="streaks-h" className="space-y-3">
        <h2 id="streaks-h" className="text-h4 font-bold text-ink">
          {t('streaksTitle')}
        </h2>
        {/* The OWNER's page, so it may say the week is still empty. The public
            one at /pasport/[handle] deliberately cannot — see StreakPanel. */}
        <StreakPanel streaks={passport.streaks} atRisk={passport.streaks.weeksAtRisk} />
      </section>

      {/*
        THE PASSPORT STORY — the image share, beside the text one.
        Offered to EVERY member regardless of passport visibility, for the same
        reason C3's text week is: the story image carries no name and no handle,
        only the member's own numbers, and it is rendered behind their session
        onto their own device. Publishing a passport is a separate decision
        about a separate artifact (the public page and its scraper-fetchable
        card); posting your own totals to your own story is not a publication.
      */}
      {passport.totals.points > 0 && (
        <ShareSheet
          variant="primary"
          payload={buildShare({
            kind: 'passport',
            locale,
            origin: siteUrl(),
            page: '/klasirane',
            text: tShare2('textPassport', { points: passport.totals.points }),
          })}
          strings={sheetPassport}
        />
      )}

      {/* C3: the Viber-native share. Offered to EVERY member, whatever their
          passport visibility (operator decision 2026-07-26) — the text carries
          no name, no handle, no place and no time, and the link goes to the
          site rather than to a profile. */}
      <WeekShare
        text={[
          tShare('weekHeading'),
          renderWeekGrid(passport.week),
          tShare('weekDays', { count: passport.week.activeDays }),
          siteUrl(),
        ].join('\n')}
      />

      <section aria-labelledby="badges-h" className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="badges-h" className="text-h4 font-bold text-ink">
            {t('badgesTitle')}
          </h2>
          {passport.newBadges.length > 0 && (
            <form action={acknowledgeBadgesAction} className="ml-auto">
              <button type="submit" className="text-caption font-medium text-link hover:text-link-hover">
                {t('acknowledgeBadges')}
              </button>
            </form>
          )}
        </div>
        <BadgeGrid badges={passport.badges} newBadges={passport.newBadges} />
      </section>

      <section aria-labelledby="history-h" className="space-y-3">
        <h2 id="history-h" className="text-h4 font-bold text-ink">
          {t('historyTitle')}
        </h2>
        <HistoryList entries={passport.history} />
      </section>

      <VisibilityPanel visibility={passport.visibility} publicUrl={publicUrl} />
      </main>
    </AppShell>
  );
}

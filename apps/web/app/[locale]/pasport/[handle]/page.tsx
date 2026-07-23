import { getDb } from '@sportkarta/db';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { PublicBadgeGrid } from '@/components/passport/badge-grid';
import { PublicActivityList } from '@/components/passport/history-list';
import { StreakPanel } from '@/components/passport/streak-panel';
import { publicPassport } from '@/lib/passport';

/**
 * A member's public sports passport (docs/ROADMAP.md §7, Stage 5.1).
 *
 * WHAT THIS PAGE MAY SHOW: badges (dated to a month), totals, streak lengths,
 * and — only if the member switched it on — per-month activity counts.
 *
 * WHAT IT MUST NEVER SHOW: a facility, a day, a time. Those are on the member's
 * own passport, which only they can open. A public page tying a named person to
 * a place and a time publishes where they reliably are; that is a
 * pattern-of-life disclosure and not something anybody consents to by clicking
 * "make my passport public". The projection is built as a whitelist in
 * apps/web/lib/passport.ts and pinned by apps/web/tests/passport-privacy.test.ts.
 *
 * NOINDEX, and absent from the sitemap. Public means "anyone I send the link
 * to", not "indexed against your name forever" — those are different decisions
 * and only the first one was made here.
 *
 * A missing handle, a private passport and a minor's passport are all the same
 * 404. Somebody holding an old link must not be able to tell which.
 */
// noindex is set in generateMetadata below, on BOTH branches — Next forbids
// exporting `metadata` and `generateMetadata` from the same page, so the
// fallback has to live inside the function rather than alongside it.
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; handle: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, handle } = await params;
  const passport = await publicPassport(getDb(), handle);
  if (!passport) return { robots: { index: false, follow: false } };
  const t = await getTranslations({ locale, namespace: 'Passport' });
  return {
    title: t('publicMetaTitle', { name: passport.displayName }),
    robots: { index: false, follow: false },
  };
}

export default async function PublicPassportPage({ params }: { params: PageParams }) {
  const { locale, handle } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Passport');

  const passport = await publicPassport(getDb(), handle);
  if (!passport) notFound();

  const totals = [
    { key: 'points', value: passport.totals.points },
    { key: 'contributions', value: passport.totals.contributions },
    { key: 'checkins', value: passport.totals.checkins },
  ] as const;

  return (
    <main className="mx-auto max-w-2xl space-y-10 p-4">
      <header className="space-y-1 border-b border-neutral-200 pb-3">
        <h1 className="text-xl font-semibold">{passport.displayName}</h1>
        <p className="text-sm text-neutral-500">
          {passport.homeCity
            ? t('publicSubtitleWithCity', {
                city: passport.homeCity,
                since: passport.memberSince,
              })
            : t('publicSubtitle', { since: passport.memberSince })}
        </p>
      </header>

      <section aria-labelledby="public-totals-h" className="space-y-3">
        <h2 id="public-totals-h" className="text-lg font-semibold">
          {t('totalsTitle')}
        </h2>
        <dl className="grid grid-cols-3 gap-3">
          {totals.map((total) => (
            <div key={total.key} className="rounded border border-neutral-200 p-3">
              <dt className="text-xs text-neutral-500">{t(`total_${total.key}`)}</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums">{total.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="public-streaks-h" className="space-y-3">
        <h2 id="public-streaks-h" className="text-lg font-semibold">
          {t('streaksTitle')}
        </h2>
        <StreakPanel streaks={passport.streaks} />
      </section>

      <section aria-labelledby="public-badges-h" className="space-y-3">
        <h2 id="public-badges-h" className="text-lg font-semibold">
          {t('badgesTitle')}
        </h2>
        <PublicBadgeGrid badges={passport.badges} />
      </section>

      {passport.activity && (
        <section aria-labelledby="public-activity-h" className="space-y-3">
          <h2 id="public-activity-h" className="text-lg font-semibold">
            {t('activityTitle')}
          </h2>
          <PublicActivityList months={passport.activity} />
        </section>
      )}
    </main>
  );
}

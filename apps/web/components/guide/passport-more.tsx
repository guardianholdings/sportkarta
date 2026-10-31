import { Check, Globe, Lock, Medal, X } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { BadgeCoins, type Coin } from '@/components/home/badge-coins';
import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { badgeArt } from '@/lib/design/badge-art';
import { LAUNCH_BADGES } from '@sportkarta/lib/badges';

import { GuideCard } from './chapter';
import { StreakStrip } from './streak-strip';

/**
 * «Паспорт», after the recording: the badge catalogue in its two groups (the
 * earned face of each coin — the catalogue, nobody's progress), the two
 * streaks with the yearly freezes, and who sees the passport.
 */
export async function PassportMore({ signedIn }: { signedIn: boolean }) {
  const [t, tBadge] = await Promise.all([
    getTranslations('Home.guide.passport'),
    getTranslations('Badge'),
  ]);
  const coins = (group: 'contribution' | 'participation'): Coin[] =>
    LAUNCH_BADGES.filter((badge) => badge.group === group).flatMap((badge) => {
      const art = badgeArt(badge.slug);
      return art
        ? [
            {
              slug: badge.slug,
              art,
              name: tBadge(`${badge.slug}.name`),
              description: tBadge(`${badge.slug}.description`),
            },
          ]
        : [];
    });
  const flip = t.raw('badges.flip') as string;

  return (
    <div className="mt-14 grid gap-4 lg:grid-cols-2">
      <GuideCard
        title={t('badges.title', { count: LAUNCH_BADGES.length })}
        icon={<Medal size={18} aria-hidden="true" />}
        className="lg:col-span-2"
      >
        <p className="text-body-sm text-ink-soft">{t('badges.hint')}</p>
        <div className="mt-5 flex flex-col gap-7">
          {(['contribution', 'participation'] as const).map((group) => (
            <div key={group}>
              <h4 className="text-body-sm font-bold uppercase tracking-wide text-text-muted">
                {t(`badges.${group}`)}
              </h4>
              <div className="mt-3">
                <BadgeCoins
                  coins={coins(group)}
                  flipLabel={flip}
                  columns="grid-cols-4 sm:grid-cols-8"
                />
              </div>
            </div>
          ))}
        </div>
      </GuideCard>

      <StreakStrip
        labels={{
          title: t('streaks.title'),
          days: { title: t('streaks.days.title'), body: t('streaks.days.body') },
          weeks: { title: t('streaks.weeks.title'), body: t('streaks.weeks.body') },
          freeze: { title: t('streaks.freeze.title'), body: t('streaks.freeze.body') },
          clock: t('streaks.clock'),
          stripLabel: t('streaks.stripLabel'),
          trained: t('streaks.trained'),
          frozen: t('streaks.frozen'),
        }}
      />

      <GuideCard title={t('privacy.title')} icon={<Lock size={18} aria-hidden="true" />}>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-line bg-paper p-3.5">
            <span className="flex items-center gap-1.5 text-body-sm font-bold text-ink">
              <Lock size={15} aria-hidden="true" />
              {t('privacy.private.title')}
            </span>
            <span className="mt-1 block text-caption text-ink-soft">
              {t('privacy.private.body')}
            </span>
          </div>
          <div className="rounded-lg border border-accent-border bg-accent-subtle p-3.5">
            <span className="flex items-center gap-1.5 text-body-sm font-bold text-accent-active">
              <Globe size={15} aria-hidden="true" />
              {t('privacy.public.title')}
            </span>
            <span className="mt-1 block text-caption text-ink-soft">
              {t('privacy.public.body')}
            </span>
          </div>
        </div>
        <ul className="mt-4 flex flex-col gap-2 text-body-sm">
          <li className="flex gap-2 text-ink">
            <Check size={17} aria-hidden="true" className="mt-0.5 shrink-0 text-brand" />
            {t('privacy.shows')}
          </li>
          <li className="flex gap-2 text-ink">
            <X size={17} aria-hidden="true" className="mt-0.5 shrink-0 text-danger" />
            {t('privacy.never')}
          </li>
        </ul>
        <p className="mt-3 text-caption text-text-muted">{t('privacy.back')}</p>
        <div className="mt-5">
          <Link href="/pasport" className={buttonVariants({ variant: 'primary' })}>
            {signedIn ? t('open') : t('start')}
          </Link>
        </div>
      </GuideCard>
    </div>
  );
}

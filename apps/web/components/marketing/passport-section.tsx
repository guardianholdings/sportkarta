import { ArrowRight, Flame, Mountain, Sparkles, Trophy } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { BadgeCoins, type Coin } from '@/components/home/badge-coins';
import { Reveal } from '@/components/motion/reveal';
import { SectionHead } from '@/components/home/section-head';
import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { badgeArt } from '@/lib/design/badge-art';

import { PassportCard } from './passport-card';
import { LAUNCH_BADGES } from '@sportkarta/lib/badges';

const FACTS = [
  { key: 'points', icon: Sparkles },
  { key: 'streaks', icon: Flame },
  { key: 'divisions', icon: Mountain },
] as const;

function Fact({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-subtle text-accent-active">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-body font-bold text-ink">{title}</span>
        <span className="mt-0.5 block text-body-sm text-ink-soft">{body}</span>
      </span>
    </li>
  );
}

/**
 * «Вашият спортен паспорт» — what a member collects: the fourteen badge coins
 * (the catalogue, earned face, nobody's progress), points, streaks and the
 * weekly divisions, and where the ranking lives. Counts and catalogue only:
 * the boards publish names on a NOINDEX page, so this indexed page links to
 * them and never lists a row (lib/home/sections.ts).
 */
export async function PassportSection({ signedIn }: { signedIn: boolean }) {
  const [t, tBadge] = await Promise.all([
    getTranslations('Home.passport'),
    getTranslations('Badge'),
  ]);

  const coins: Coin[] = LAUNCH_BADGES.flatMap((badge) => {
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

  return (
    <section
      aria-labelledby="home-passport"
      className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20"
    >
      <Reveal className="grid gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
        <div className="min-w-0" data-reveal>
          <SectionHead
            id="home-passport"
            overline={t('overline')}
            title={t('title')}
            lead={t('lead')}
          />
          <h3 className="mt-8 text-h4 font-extrabold tracking-tight text-ink">
            {t('badgesTitle', { count: coins.length })}
          </h3>
          <p className="mt-1 text-body-sm text-ink-soft">{t('badgesHint')}</p>
          <div className="mt-4">
            <BadgeCoins coins={coins} flipLabel={t.raw('flip') as string} />
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-6 lg:pt-14" data-reveal>
          <PassportCard
            labels={{
              sample: t('sample.label'),
              initials: t('sample.initials'),
              name: t('sample.name'),
              city: t('sample.city'),
              points: t('sample.points'),
              streak: t('sample.streak'),
              badges: t('sample.badges'),
              note: t('sample.note'),
            }}
            coins={coins.slice(0, 3).map((coin) => ({ src: coin.art, name: coin.name }))}
          />
          <ul className="flex flex-col gap-4">
            {FACTS.map((fact) => (
              <Fact
                key={fact.key}
                icon={<fact.icon size={20} aria-hidden="true" />}
                title={t(`${fact.key}.title`)}
                body={t(`${fact.key}.body`)}
              />
            ))}
          </ul>
          <Link
            href="/klasirane"
            className="group flex items-center gap-4 rounded-card border border-line bg-surface p-5 transition-[border-color,box-shadow] duration-150 ease-standard hover:border-brand-border hover:shadow-sm focus-visible:shadow-[var(--ring)]"
          >
            <Trophy size={22} aria-hidden="true" className="shrink-0 text-accent-active" />
            <span className="min-w-0 flex-1">
              <span className="block text-body font-bold text-ink group-hover:text-brand">
                {t('leaderboardTitle')}
              </span>
              <span className="mt-0.5 block text-body-sm text-ink-soft">
                {t('leaderboardBody')}
              </span>
            </span>
            <ArrowRight size={20} aria-hidden="true" className="shrink-0 text-text-muted" />
          </Link>
          <p className="text-body-sm text-ink-soft">{t('consent')}</p>
          <div>
            <Link href="/pasport" className={buttonVariants({ variant: 'primary' })}>
              {signedIn ? t('open') : t('start')}
            </Link>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

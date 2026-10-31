import { Dumbbell, Flower2, Trophy, UserRound } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { SectionHead } from '@/components/home/section-head';
import { Reveal } from '@/components/motion/reveal';
import { CLUB_KINDS, type ClubKind } from '@sportkarta/lib/clubs';

const ICONS: Record<ClubKind, typeof Dumbbell> = {
  gym: Dumbbell,
  studio: Flower2,
  club: Trophy,
  trainer: UserRound,
  other: UserRound,
};

/**
 * «За кого» — one tile per kind of club the application form knows
 * (CLUB_KINDS, labels from `Club.kind`), each with the functions that matter
 * most to that kind. «Друго» is a form choice, not an audience.
 */
export async function Audiences() {
  const [t, tClub] = await Promise.all([getTranslations('ClubsLanding'), getTranslations('Club')]);
  const kinds = CLUB_KINDS.filter((kind) => kind !== 'other');
  return (
    <section
      aria-labelledby="clubs-audiences"
      className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20"
    >
      <SectionHead
        id="clubs-audiences"
        overline={t('audiences.overline')}
        title={t('audiences.title')}
        lead={t('audiences.lead')}
      />
      <Reveal>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {kinds.map((kind) => {
            const Icon = ICONS[kind];
            return (
              <li
                key={kind}
                data-reveal
                className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5"
              >
                <span className="grid size-11 place-items-center rounded-full bg-brand-subtle text-brand">
                  <Icon size={22} aria-hidden="true" />
                </span>
                <span className="text-body font-bold text-ink">{tClub(`kind.${kind}`)}</span>
                <span className="text-body-sm text-ink-soft">{t(`audiences.${kind}`)}</span>
              </li>
            );
          })}
        </ul>
      </Reveal>
    </section>
  );
}

import { Dumbbell, Flower2, Trophy, UserRound } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { SectionHead } from '@/components/home/section-head';
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
      <SectionHead id="clubs-audiences" title={t('audiences.title')} lead={t('audiences.lead')} />
      <div>
        <ul className="mt-10 grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
          {kinds.map((kind) => {
            const Icon = ICONS[kind];
            return (
              // Four columns under one rule each, like the columns of a
              // timetable: the kind of club set large, its tools under it.
              <li key={kind} className="flex flex-col gap-2 border-t-2 border-ink pt-4">
                <span className="flex items-center justify-between gap-3">
                  <span className="font-display text-h4 font-extrabold tracking-tight text-ink">
                    {tClub(`kind.${kind}`)}
                  </span>
                  <Icon size={22} aria-hidden="true" className="shrink-0 text-brand" />
                </span>
                <span className="text-body-sm text-ink-soft">{t(`audiences.${kind}`)}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

import { getTranslations } from 'next-intl/server';

import { SectionHead } from '@/components/home/section-head';
import { Reveal } from '@/components/motion/reveal';

import { DayInClub, type DayMoment } from './day-in-club';

/**
 * The moments of the day, each naming the catalogue areas it runs on. A
 * moment that needs an outside service (online payment) is told only while
 * the operator has switched it on — the story never claims what the office
 * cannot do today.
 */
const MOMENTS: { key: string; areas: string[]; service?: 'payments' }[] = [
  { key: 'open', areas: ['attendance', 'portal'] },
  { key: 'trial', areas: ['schedule', 'inbox', 'website'] },
  { key: 'buy', areas: ['payments', 'plans'], service: 'payments' },
  { key: 'desk', areas: ['plans', 'members'] },
  { key: 'roster', areas: ['schedule', 'attendance'] },
  { key: 'auto', areas: ['messaging', 'members'] },
  { key: 'report', areas: ['dashboard', 'reports'] },
];

export async function DaySection({ paymentsOn }: { paymentsOn: boolean }) {
  const t = await getTranslations('ClubsLanding');
  const moments: DayMoment[] = MOMENTS.filter((m) => !m.service || paymentsOn).map((m) => ({
    key: m.key,
    time: t(`day.moments.${m.key}.time`),
    title: t(`day.moments.${m.key}.title`),
    body: t(`day.moments.${m.key}.body`),
    areas: m.areas.map((key) => ({ key, label: t(`catalogue.${key}.title`) })),
  }));
  return (
    <section aria-labelledby="clubs-day" className="border-t border-line bg-paper">
      <Reveal className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
        <div data-reveal>
          <SectionHead
            id="clubs-day"
            overline={t('day.overline')}
            title={t('day.title')}
            lead={t('day.lead')}
          />
        </div>
        <div className="mt-10" data-reveal>
          <DayInClub moments={moments} openLabel={t('day.openLabel')} />
        </div>
      </Reveal>
    </section>
  );
}

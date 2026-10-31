import { getTranslations } from 'next-intl/server';

import { Reveal } from '@/components/motion/reveal';

import { Journey, type JourneyStep } from './journey';

const STEPS: { key: JourneyStep['key']; href: JourneyStep['href'] }[] = [
  { key: 'find', href: '/karta' },
  { key: 'join', href: '/sesii' },
  { key: 'collect', href: '/pasport' },
];

/**
 * «Как работи» — the three acts of the free product as three small films
 * (journey.tsx), each one a link: find a place, join a тренировка, collect
 * the passport. Deliberately nothing about clubs here: the module is
 * mentioned in exactly one section of the page.
 */
export async function HowItWorks() {
  const t = await getTranslations('Home.how');
  return (
    <section
      aria-labelledby="home-how"
      className="mx-auto max-w-6xl px-4 pb-6 pt-2 sm:px-6 lg:px-8 lg:pb-10"
    >
      <h2 id="home-how" className="sr-only">
        {t('title')}
      </h2>
      <Reveal stagger={0.12}>
        <Journey
          pointsLabel={t('points')}
          steps={STEPS.map((step) => ({
            ...step,
            title: t(`${step.key}.title`),
            body: t(`${step.key}.body`),
          }))}
        />
      </Reveal>
    </section>
  );
}

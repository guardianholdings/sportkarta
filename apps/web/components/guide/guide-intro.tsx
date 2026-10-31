import { getTranslations } from 'next-intl/server';

import { SectionHead } from '@/components/home/section-head';
import { Reveal } from '@/components/motion/reveal';

import { GUIDE_CHAPTERS } from './chapter';

/**
 * The guide's contents: the five chapters as five stops on one dotted route,
 * each a jump to its chapter. The route is the map's own grain — the dots of
 * the hero — run sideways.
 */
export async function GuideIntro() {
  const t = await getTranslations('Home.guide');
  return (
    <section
      aria-labelledby="guide-intro"
      className="mx-auto max-w-6xl px-4 pb-4 pt-14 sm:px-6 lg:px-8 lg:pt-20"
    >
      <SectionHead
        id="guide-intro"
        overline={t('intro.overline')}
        title={t('intro.title')}
        lead={t('intro.lead')}
      />
      <Reveal stagger={0.08}>
        <ol className="sk-route mt-10 grid gap-2 sm:grid-cols-2 lg:grid-cols-5 lg:gap-4">
          {GUIDE_CHAPTERS.map((chapter, index) => (
            <li key={chapter.id} data-reveal>
              <a href={`#${chapter.id}`} className="sk-route__stop group">
                <span aria-hidden="true" className="sk-route__dot">
                  {index + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-body font-extrabold text-ink group-hover:text-brand">
                    {t(`nav.${chapter.key}`)}
                  </span>
                  <span className="mt-1 block text-body-sm text-ink-soft">
                    {t(`intro.${chapter.key}`)}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ol>
      </Reveal>
    </section>
  );
}

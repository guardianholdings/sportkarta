import { ArrowRight } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { Reveal } from '@/components/motion/reveal';
import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { CLUB_TRIAL_DAYS } from '@sportkarta/lib/clubs';

import { SectionHead } from './section-head';

/**
 * «Водете клуба си в POPS» — the ONE place the front page mentions the
 * «Клубове» module, and lightly: an overline, a title, a sentence and a door.
 * Everything a club owner needs to read — every function, the prices, the
 * questions — lives on the clubs page the door opens; this page is the
 * players'. Rendered only while CLUBS_ENABLED is on (the page decides).
 */
export async function ClubsSection() {
  const t = await getTranslations('Home.clubs');
  return (
    <section aria-labelledby="home-clubs" className="border-y border-line bg-surface">
      <Reveal className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-8 lg:py-14">
        <SectionHead id="home-clubs" overline={t('overline')} title={t('title')} lead={t('lead', { days: CLUB_TRIAL_DAYS })}>
          <Link href="/za-klubove" className={buttonVariants({ variant: 'accent' })}>
            {t('cta')}
            <ArrowRight size={18} aria-hidden="true" />
          </Link>
        </SectionHead>
      </Reveal>
    </section>
  );
}

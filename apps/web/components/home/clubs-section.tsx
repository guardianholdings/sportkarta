import { ArrowRight } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';

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
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-8 lg:py-14">
        <SectionHead id="home-clubs" overline={t('overline')} title={t('title')} lead={t('lead')}>
          <Link href="/za-klubove" className={buttonVariants({ variant: 'accent' })}>
            {t('cta')}
            <ArrowRight size={18} aria-hidden="true" />
          </Link>
        </SectionHead>
      </div>
    </section>
  );
}

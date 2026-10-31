import { getTranslations } from 'next-intl/server';

import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import { CLUB_TRIAL_DAYS } from '@sportkarta/lib/clubs';

/** The last screen: the promise once more, the one call to action, and a way to ask. */
export async function FinalCta() {
  const t = await getTranslations('ClubsLanding.final');
  return (
    <section aria-labelledby="clubs-final" className="bg-ink text-paper">
      <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
        <h2
          id="clubs-final"
          className="max-w-2xl text-h2 font-extrabold leading-tight tracking-tight text-paper sm:text-h1"
        >
          {t('title')}
        </h2>
        <p className="max-w-2xl text-body text-paper/75">{t('lead', { days: CLUB_TRIAL_DAYS })}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/klubove/zayavka"
            className={buttonVariants({ variant: 'accent', size: 'lg' })}
          >
            {t('cta')}
          </Link>
          <Link
            href="/kontakt"
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'lg' }),
              'text-paper hover:bg-paper/10 active:bg-paper/15',
            )}
          >
            {t('contact')}
          </Link>
        </div>
      </div>
    </section>
  );
}

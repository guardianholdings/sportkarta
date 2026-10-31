import { Check } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { Reveal } from '@/components/motion/reveal';
import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import {
  CLUB_CONTRACT_MONTHS,
  CLUB_CONTRACT_NOTICE_MONTHS,
  CLUB_TRIAL_DAYS,
} from '@sportkarta/lib/clubs';

import { DeviceFrame } from './device-frame';
import { HeroToasts } from './hero-toasts';
import { SHOTS } from './shots';

export const CLUBS_HERO_ID = 'za-klubove-hero';

const ASSURANCES = ['trial', 'contract', 'cancel', 'export'] as const;
const TOASTS = ['checkin', 'lead', 'renewal', 'reminder'] as const;

/**
 * The first screen of the clubs page: the promise, the one call to action,
 * the four terms an owner weighs before applying (a free trial, then a
 * contract — lib/src/clubs/contract.ts — and their data), and the platform
 * as it looks. The «без комисиона» line renders only while the platform fee is
 * zero AND online payments are switched on (lib/clubs/landing.ts).
 */
export async function LandingHero({
  feeFree,
  paymentsOn,
}: {
  feeFree: boolean;
  /** CLUB_PAYMENTS_ENABLED: the Stripe sentence and the fee line exist only then. */
  paymentsOn: boolean;
}) {
  const t = await getTranslations('ClubsLanding');
  const shot = SHOTS.hero;
  return (
    <section id={CLUBS_HERO_ID} aria-labelledby="clubs-title" className="sk-home-hero">
      <div
        className={cn(
          'mx-auto grid max-w-6xl items-center gap-x-14 gap-y-10 px-4 pb-14 pt-10 sm:px-6 lg:px-8 lg:pb-20 lg:pt-16',
          shot && 'lg:grid-cols-[minmax(0,6fr)_minmax(0,6fr)]',
        )}
      >
        <div className="flex min-w-0 flex-col gap-6">
          <p className="sk-overline">{t('hero.overline')}</p>
          <h1
            id="clubs-title"
            className="text-h1 font-extrabold leading-tight tracking-tight text-ink sm:text-display-lg"
          >
            {t('hero.title')}
          </h1>
          <p className="max-w-xl text-body-lg text-ink-soft">
            {t('hero.lead')}
            {paymentsOn && <> {t('hero.leadPayments')}</>}
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/klubove/zayavka"
              className={buttonVariants({ variant: 'accent', size: 'lg' })}
            >
              {t('cta')}
            </Link>
            <a href="#ceni" className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
              {t('hero.prices')}
            </a>
          </div>
          {feeFree && paymentsOn && (
            <p className="text-body-sm font-semibold text-brand">{t('hero.fee')}</p>
          )}
          <ul className="grid gap-2 text-body-sm text-ink-soft sm:grid-cols-2">
            {ASSURANCES.map((key) => (
              <li key={key} className="flex items-start gap-2">
                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-brand-subtle text-brand">
                  <Check size={13} strokeWidth={3} aria-hidden="true" />
                </span>
                {t(`assurances.${key}`, {
                  days: CLUB_TRIAL_DAYS,
                  months: CLUB_CONTRACT_MONTHS,
                  notice: CLUB_CONTRACT_NOTICE_MONTHS,
                })}
              </li>
            ))}
          </ul>
        </div>
        {shot && (
          <Reveal y={40}>
            {/* Clipped: the notices slide in from outside the frame. */}
            <div className="relative overflow-hidden rounded-card">
              <DeviceFrame shot={shot} alt={t('hero.shotAlt')} eager />
              <HeroToasts
                toasts={TOASTS.map((key) => ({
                  title: t(`hero.toasts.${key}.title`),
                  body: t(
                    key === 'renewal' && !paymentsOn
                      ? 'hero.toasts.renewal.bodyDesk'
                      : `hero.toasts.${key}.body`,
                  ),
                }))}
              />
            </div>
          </Reveal>
        )}
      </div>
    </section>
  );
}

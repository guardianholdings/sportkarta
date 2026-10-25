import { ArrowRight, Check } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { clubSportLabeler } from '@/lib/clubs/labels';
import type { ClubTeaser } from '@/lib/home/sections';
import { cityDisplayName, loadCityCatalog } from '@/lib/places';
import { cn } from '@/lib/utils';

import { SectionHead } from './section-head';

const OWNER_POINTS = ['schedule', 'money', 'kiosk', 'passport', 'page'] as const;

/**
 * «Клубове, зали и студиа» — only while CLUBS_ENABLED is on (the page passes
 * null otherwise). Two audiences side by side: a member looking for a class,
 * and an owner looking for a tool.
 *
 * The cards are the /klubove directory's, with its rules: renderable clubs only
 * (CLUB_RENDERABLE inside publicClubDirectory), no tier shown, no paid place —
 * order comes from having a class this week, then the name.
 */
export async function ClubsSection({ teaser, locale }: { teaser: ClubTeaser; locale: string }) {
  const [t, tPublic, tClub, sportLabel, catalog] = await Promise.all([
    getTranslations('Home.clubs'),
    getTranslations('ClubPublic'),
    getTranslations('Club'),
    clubSportLabeler(),
    loadCityCatalog(),
  ]);
  const cityName = (id: number | null) => {
    const city = id === null ? undefined : catalog.byId.get(id);
    return city ? cityDisplayName(city.nameBg, city.nameEn, locale) : null;
  };

  return (
    <section
      aria-labelledby="home-clubs"
      className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20"
    >
      <div className="grid gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="min-w-0">
          <SectionHead
            id="home-clubs"
            overline={t('overline')}
            title={t('title')}
            lead={t('lead')}
          />
          {teaser.clubs.length === 0 ? (
            <p className="mt-8 rounded-card border border-dashed border-line-strong p-6 text-body-sm text-text-muted">
              {t('empty')}
            </p>
          ) : (
            <ul className="mt-8 grid gap-3 sm:grid-cols-2">
              {teaser.clubs.map((club) => {
                const city = cityName(club.municipalityId);
                return (
                  <li key={club.id}>
                    <Link
                      href={`/klub/${club.slug}`}
                      className="flex h-full gap-3 rounded-card border border-line bg-surface p-4 shadow-sm transition-[border-color,box-shadow] duration-150 ease-standard hover:border-brand-border hover:shadow-md focus-visible:shadow-[var(--ring)]"
                    >
                      {club.hasLogo ? (
                        // eslint-disable-next-line @next/next/no-img-element -- the row-decides logo route
                        <img
                          src={`/api/clubs/logo/${club.id}`}
                          alt=""
                          width={48}
                          height={48}
                          className="size-12 shrink-0 rounded-xs object-contain"
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          className="grid size-12 shrink-0 place-items-center rounded-md bg-brand-subtle font-display text-h4 font-extrabold text-brand"
                        >
                          {club.name.slice(0, 1)}
                        </span>
                      )}
                      <span className="min-w-0 space-y-1">
                        <span className="block truncate text-body font-bold text-ink">
                          {club.name}
                        </span>
                        <span className="flex flex-wrap gap-1.5">
                          <Badge tone="neutral">{tClub(`kind.${club.kind}`)}</Badge>
                          {city && <Badge tone="info">{city}</Badge>}
                        </span>
                        {club.sports.length > 0 && (
                          <span className="block truncate text-caption text-text-muted">
                            {club.sports.slice(0, 4).map(sportLabel).join(' · ')}
                          </span>
                        )}
                        <span className="block text-caption font-medium text-ink-soft">
                          {tPublic('classesThisWeek', { count: club.classesThisWeek })}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {teaser.total > 0 && (
            <Link
              href="/klubove"
              className="mt-4 inline-flex items-center gap-1 text-body-sm font-semibold text-link hover:text-link-hover"
            >
              {t('all', { count: teaser.total })}
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          )}
        </div>

        <aside
          aria-labelledby="home-clubs-owners"
          className="flex flex-col gap-5 rounded-card bg-ink p-6 text-paper shadow-lg sm:p-8"
        >
          <p className="sk-overline sk-overline--dark">{t('ownerOverline')}</p>
          <h3 id="home-clubs-owners" className="text-h2 font-extrabold tracking-tight text-paper">
            {t('ownerTitle')}
          </h3>
          <ul className="flex flex-col gap-3">
            {OWNER_POINTS.map((key) => (
              <li key={key} className="flex items-start gap-3 text-body-sm text-paper/85">
                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-accent text-on-accent">
                  <Check size={13} strokeWidth={3} aria-hidden="true" />
                </span>
                {t(`ownerPoints.${key}`)}
              </li>
            ))}
          </ul>
          <p className="text-body-sm font-semibold text-paper">{t('ownerFree')}</p>
          <div className="mt-auto flex flex-wrap gap-2 pt-2">
            <Link href="/klubove/zayavka" className={buttonVariants({ variant: 'accent' })}>
              {t('apply')}
            </Link>
            <Link
              href="/klubove"
              className={cn(
                buttonVariants({ variant: 'ghost' }),
                'text-paper hover:bg-paper/10 active:bg-paper/15',
              )}
            >
              {t('learnMore')}
            </Link>
          </div>
        </aside>
      </div>
    </section>
  );
}

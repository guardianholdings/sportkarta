import { daysUntilReadOnly, sofiaToday } from '@sportkarta/lib/clubs';
import { Map as MapIcon, User } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { BrandMark } from '@/components/shell/app-nav';
import { Badge } from '@/components/ui/badge';
import { Link } from '@/i18n/navigation';
import { actorCan, clubName, type ClubContext } from '@/lib/clubs/club-session';
import { featureOn } from '@/lib/clubs/features';
import { groupOfficeSections, OFFICE_SECTIONS } from '@/lib/clubs/office-nav';
import { formatDate } from '@/lib/format';

import { ClubStateBadge } from './club-state-badge';
import { OfficeNav } from './office-nav';

/**
 * The club office's chrome (docs/ROADMAP.md Stage 9): the POPS mark, the club,
 * the person's role there, a club switcher for people who work at several, the
 * office nav — FILTERED by what the role may see — and one banner saying what
 * the club's access state means for today.
 *
 * The nav groups the sections into seven hubs (lib/clubs/office-nav.ts,
 * operator decision 2026-10-31): a row of hubs, then the sections of the hub
 * you are in (OfficeNav). Filtering here is for RENDERING only: every page
 * gates itself with requireClubStaff and every statement carries its own
 * scope.
 */

export async function ClubShell({
  context,
  otherClubs,
  children,
}: {
  context: ClubContext;
  otherClubs: { slug: string; name: string }[];
  children: React.ReactNode;
}) {
  const [t, tClub, tNav, locale] = await Promise.all([
    getTranslations('ClubOffice'),
    getTranslations('Club'),
    getTranslations('Nav'),
    getLocale(),
  ]);
  const { club, actor } = context;
  const base = `/klub/${club.slug}`;
  const visible = OFFICE_SECTIONS.filter(
    (item) =>
      actorCan(actor, item.permission) &&
      (item.feature === undefined || featureOn(club, item.feature)),
  );
  const hubs = groupOfficeSections(visible).map((hub) => ({
    key: hub.key,
    label: t(`hubs.${hub.key}`),
    items: hub.sections.map((item) => ({
      href: `${base}/${item.segment}`,
      label: t(`nav.${item.key}`),
    })),
    also: hub.also.map((segment) => `${base}/${segment}`),
  }));
  const state = club.accessState;
  const banner = (() => {
    switch (state) {
      case 'pending':
      case 'lapsed':
      case 'suspended':
      case 'archived':
        return t(`banner.${state}`);
      case 'trial':
        return club.trialEndsOn
          ? t('banner.trial', { date: formatDate(club.trialEndsOn, locale) })
          : null;
      case 'past_due':
        return t('banner.past_due', {
          days: Math.max(0, daysUntilReadOnly(club, sofiaToday()) ?? 0),
        });
      default:
        return null;
    }
  })();
  const name = clubName(club, locale);

  return (
    <div className="mx-auto max-w-6xl px-4 py-4">
      <header className="mb-6 border-b border-line pb-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <BrandMark label={tNav('navBrand')} />
            {club.logoPath && (
              // eslint-disable-next-line @next/next/no-img-element -- the row-decides logo route
              <img
                src={`/api/clubs/logo/${club.id}`}
                alt=""
                width={24}
                height={24}
                className="size-6 shrink-0 rounded-sm object-contain"
              />
            )}
            <span className="truncate text-body font-bold text-ink">{name}</span>
            <Badge tone="neutral">{actor.role ? tClub(`role.${actor.role}`) : t('ngoAdmin')}</Badge>
            <ClubStateBadge state={state} label={tClub(`state.${state}`)} />
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
            {otherClubs.length > 0 && (
              <details className="relative">
                <summary className="inline-flex min-h-11 cursor-pointer list-none items-center rounded-pill px-3 text-caption font-semibold text-ink-soft hover:bg-surface-2">
                  {t('switchClub')}
                </summary>
                <ul className="absolute right-0 z-30 mt-1 min-w-56 rounded-card border border-line bg-surface p-1 shadow-md">
                  {otherClubs.map((other) => (
                    <li key={other.slug}>
                      <Link
                        href={`/klub/${other.slug}/tablo`}
                        className="flex min-h-11 items-center rounded-sm px-3 text-body-sm text-ink hover:bg-surface-2"
                      >
                        {other.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <Link
              href="/karta"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-pill border border-line-strong bg-surface px-3 text-caption font-semibold text-ink-soft hover:bg-surface-2"
            >
              <MapIcon size={15} aria-hidden="true" />
              {t('map')}
            </Link>
            <Link
              href="/profil"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-pill px-3 text-caption font-semibold text-ink-soft hover:bg-surface-2"
            >
              <User size={15} aria-hidden="true" />
              {t('profile')}
            </Link>
          </div>
        </div>
        <OfficeNav hubs={hubs} labels={{ hubs: t('hubsLabel'), sections: t('sectionsLabel') }} />
        {banner && (
          <p
            role="status"
            className={`mt-3 rounded-card border px-3 py-2 text-body-sm ${
              state === 'trial'
                ? 'border-brand-border bg-brand-subtle text-ink'
                : 'border-warning-border bg-warning-bg text-ink'
            }`}
          >
            {banner}
          </p>
        )}
      </header>
      {children}
    </div>
  );
}

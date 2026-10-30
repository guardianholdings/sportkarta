import {
  daysUntilReadOnly,
  sofiaToday,
  type ClubFeature,
  type ClubPermission,
} from '@sportkarta/lib/clubs';
import { Map as MapIcon, User } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { AdminNav } from '@/components/shell/admin-nav';
import { BrandMark } from '@/components/shell/app-nav';
import { Badge } from '@/components/ui/badge';
import { Link } from '@/i18n/navigation';
import { actorCan, clubName, type ClubContext } from '@/lib/clubs/club-session';
import { featureOn } from '@/lib/clubs/features';
import { formatDate } from '@/lib/format';

import { ClubStateBadge } from './club-state-badge';

/**
 * The club office's chrome (docs/ROADMAP.md Stage 9): the POPS mark, the club,
 * the person's role there, a club switcher for people who work at several, the
 * office nav — FILTERED by what the role may see — and one banner saying what
 * the club's access state means for today.
 *
 * The nav reuses components/shell/admin-nav.tsx unchanged (longest-prefix
 * current-page marking); on a phone it is one sideways-scrolling row of 44px
 * targets, the admin layout's classes. Filtering here is for RENDERING only:
 * every page gates itself with requireClubStaff and every statement carries
 * its own scope.
 */

const NAV: readonly {
  segment: string;
  key: string;
  permission: ClubPermission;
  /** Shown only when the club's tier (and any operator switch) includes it. */
  feature?: ClubFeature;
}[] = [
  { segment: 'tablo', key: 'dashboard', permission: 'office.view' },
  { segment: 'prisastviya', key: 'desk', permission: 'attendance.record' },
  { segment: 'grafik', key: 'schedule', permission: 'schedule.view' },
  { segment: 'kalendar', key: 'calendar', permission: 'schedule.view' },
  { segment: 'vhodyashti', key: 'inbox', permission: 'inbox.reply' },
  { segment: 'chlenove', key: 'members', permission: 'members.view' },
  { segment: 'abonamenti', key: 'plans', permission: 'sales.manage' },
  { segment: 'uslugi', key: 'services', permission: 'schedule.manage' },
  { segment: 'plashtaniya', key: 'payments', permission: 'payments.view' },
  { segment: 'prodazhbi', key: 'sales', permission: 'shop.sell', feature: 'shop' },
  { segment: 'produkti', key: 'products', permission: 'shop.manage', feature: 'shop' },
  { segment: 'promocii', key: 'promotions', permission: 'plans.manage', feature: 'promotions' },
  { segment: 'fakturi', key: 'invoices', permission: 'invoices.issue', feature: 'invoices' },
  {
    segment: 'saobshteniya',
    key: 'messages',
    permission: 'messages.send',
    feature: 'broadcasts',
  },
  { segment: 'otzivi', key: 'feedback', permission: 'feedback.view', feature: 'feedback' },
  { segment: 'otcheti', key: 'reports', permission: 'reports.view' },
  { segment: 'ekip', key: 'team', permission: 'staff.view' },
  { segment: 'resursi', key: 'resources', permission: 'settings.manage' },
  { segment: 'nastroyki', key: 'settings', permission: 'settings.manage' },
];

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
  const items = NAV.filter(
    (item) =>
      actorCan(actor, item.permission) &&
      (item.feature === undefined || featureOn(club, item.feature)),
  ).map((item) => ({
    href: `${base}/${item.segment}`,
    label: t(`nav.${item.key}`),
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
              href="/"
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
        <div className="-mx-4 overflow-x-auto px-4 max-sm:[&_a]:inline-flex max-sm:[&_a]:min-h-11 max-sm:[&_a]:shrink-0 max-sm:[&_a]:items-center max-sm:[&_a]:whitespace-nowrap max-sm:[&>nav]:flex-nowrap">
          <AdminNav items={items} />
        </div>
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

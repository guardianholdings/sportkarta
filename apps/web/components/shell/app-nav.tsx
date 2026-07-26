import { CalendarDays, Map as MapIcon, MapPin, Plus, Trophy, User } from 'lucide-react';

import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

/**
 * App-wide primary navigation (desktop left rail + mobile bottom tab bar).
 * Pure and props-driven — no hooks, no server imports — so the map page's
 * client explorer and the server-rendered AppShell share one source of truth.
 * Labels come from the `Nav` i18n namespace via `labelFor`.
 */

export const NAV = [
  { key: 'navMap', href: '/', icon: MapIcon },
  { key: 'navSessions', href: '/sesii', icon: CalendarDays },
  { key: 'navLeaderboards', href: '/klasirane', icon: Trophy },
  { key: 'navProfile', href: '/profil', icon: User },
] as const;

export type NavItem = (typeof NAV)[number];
export type NavKey = NavItem['key'] | 'navAdd';
export type ActiveHref = NavItem['href'];

export function BrandMark() {
  return (
    <Link href="/" aria-label="SportKarta" className="grid size-9 place-items-center rounded-md bg-brand text-on-brand">
      <MapPin size={20} />
    </Link>
  );
}

export function NavRail({
  active,
  labelFor,
  className,
  showAdd = true,
}: {
  active?: ActiveHref | null;
  labelFor: (key: NavKey) => string;
  className?: string;
  /** The map screen renders its own add-facility FAB over the map instead. */
  showAdd?: boolean;
}) {
  return (
    <nav
      className={cn(
        'flex w-[76px] shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-4',
        className,
      )}
    >
      <BrandMark />
      <div className="mt-4 flex flex-1 flex-col gap-1">
        {NAV.map((n) => (
          <NavRailItem key={n.key} item={n} active={n.href === active} label={labelFor(n.key)} />
        ))}
        {showAdd && (
          <Link
            href="/dobavi"
            className="mt-2 flex flex-col items-center gap-1 rounded-md px-2 py-2 text-[11px] font-semibold text-ink-soft hover:bg-surface-2"
          >
            <span className="grid size-9 place-items-center rounded-full bg-accent text-on-accent shadow-xs">
              <Plus size={20} />
            </span>
            {labelFor('navAdd')}
          </Link>
        )}
      </div>
    </nav>
  );
}

function NavRailItem({ item, active, label }: { item: NavItem; active: boolean; label: string }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={`flex flex-col items-center gap-1 rounded-md px-2 py-2 text-[11px] font-semibold ${
        active ? 'bg-brand-subtle text-brand' : 'text-ink-soft hover:bg-surface-2'
      }`}
    >
      <Icon size={22} />
      {label}
    </Link>
  );
}

export function BottomNav({
  active,
  labelFor,
  className,
}: {
  active?: ActiveHref | null;
  labelFor: (key: NavKey) => string;
  className?: string;
}) {
  return (
    <div className={cn('flex h-14 items-center border-t border-line bg-surface', className)}>
      {NAV.slice(0, 2).map((n) => (
        <TabItem key={n.key} item={n} active={n.href === active} label={labelFor(n.key)} />
      ))}
      <div className="w-14" />
      {NAV.slice(2).map((n) => (
        <TabItem key={n.key} item={n} active={n.href === active} label={labelFor(n.key)} />
      ))}
      <Link
        href="/dobavi"
        aria-label={labelFor('navAdd')}
        className="absolute left-1/2 top-[-22px] grid size-[54px] -translate-x-1/2 place-items-center rounded-full border-[3px] border-surface bg-accent text-on-accent shadow-lg active:scale-[0.97]"
      >
        <Plus size={26} />
      </Link>
    </div>
  );
}

function TabItem({ item, active, label }: { item: NavItem; active: boolean; label: string }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={`flex flex-1 flex-col items-center gap-0.5 text-[11px] font-semibold ${
        active ? 'text-brand' : 'text-text-muted'
      }`}
    >
      <Icon size={23} />
      {label}
    </Link>
  );
}

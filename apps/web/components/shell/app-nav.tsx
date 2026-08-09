import { CalendarDays, Map as MapIcon, Plus, Trophy, User } from 'lucide-react';

import { PopsMark } from '@/components/shell/pops-mark';
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
export type NavKey = NavItem['key'] | 'navAdd' | 'navBrand' | 'navPrimary' | 'skipToContent';
export type ActiveHref = NavItem['href'];

/**
 * The brand mark („Усмивката") in raw coral — the mark's own colour, never a
 * tile: the brand rules forbid boxing or recolouring it. `label` is the
 * accessible name (Nav.navBrand), passed in because this file stays pure.
 */
export function BrandMark({ label }: { label: string }) {
  return (
    <Link href="/" aria-label={label} className="grid size-11 place-items-center text-accent">
      <PopsMark size={40} />
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
      aria-label={labelFor('navPrimary')}
      className={cn(
        'flex w-[76px] shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-4',
        className,
      )}
    >
      <BrandMark label={labelFor('navBrand')} />
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
    <nav
      aria-label={labelFor('navPrimary')}
      className={cn(
        // min-h + safe-area padding, not a fixed h-14: in the installed PWA the
        // iOS/Android home indicator overlays the bottom edge, and the inset
        // keeps the tabs above it.
        'flex min-h-14 items-center border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]',
        className,
      )}
    >
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
        className="absolute left-1/2 top-[-22px] grid size-[54px] -translate-x-1/2 place-items-center rounded-full border-[3px] border-surface bg-accent text-on-accent shadow-lg transition-[transform,box-shadow] duration-150 ease-standard focus-visible:shadow-[var(--ring-accent)] active:scale-[0.97]"
      >
        <Plus size={26} />
      </Link>
    </nav>
  );
}

function TabItem({ item, active, label }: { item: NavItem; active: boolean; label: string }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      // `h-full justify-center` rather than letting the content size the link:
      // icon + label measured 42px inside the 56px bar, leaving 7px of dead
      // strip above and below each tab and putting the primary navigation under
      // the 44px touch floor. The bar is unchanged; the hit area now fills it.
      className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 self-stretch text-[11px] font-semibold ${
        active ? 'text-brand' : 'text-ink-soft'
      }`}
    >
      <Icon size={23} />
      {label}
    </Link>
  );
}

import {
  Building2,
  CalendarDays,
  Database,
  Map as MapIcon,
  Plus,
  Trophy,
  User,
} from 'lucide-react';

import { LocaleSwitcher } from '@/components/shell/locale-switcher';
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
  { key: 'navMap', href: '/karta', icon: MapIcon },
  { key: 'navSessions', href: '/sesii', icon: CalendarDays },
  { key: 'navLeaderboards', href: '/klasirane', icon: Trophy },
  { key: 'navProfile', href: '/profil', icon: User },
] as const;

/**
 * The rail's foot, under the primary tabs: the open data and, while the
 * «Клубове» add-on is on, the page for clubs — the links the marketing pages'
 * own header used to carry (operator, 2026-10-31: one menu, not two).
 * Desktop only: the bottom bar keeps its four tabs, and on a phone both pages
 * are a tap away from the front page and the footer.
 */
export const NAV_MORE = [
  { key: 'navData', href: '/danni', icon: Database },
  { key: 'navClubs', href: '/za-klubove', icon: Building2 },
] as const;

export type NavItem = (typeof NAV)[number];
type RailItem = NavItem | (typeof NAV_MORE)[number];
export type NavKey = RailItem['key'] | 'navAdd' | 'navBrand' | 'navPrimary' | 'skipToContent';
export type ActiveHref = RailItem['href'];

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
  clubs = false,
}: {
  active?: ActiveHref | null;
  labelFor: (key: NavKey) => string;
  className?: string;
  /** The map screen renders its own add-facility FAB over the map instead. */
  showAdd?: boolean;
  /**
   * Whether the «Клубове» add-on is on (clubsEnabled()): every club route
   * 404s while it is off, so the rail links /za-klubove only with this set.
   */
  clubs?: boolean;
}) {
  return (
    <nav
      aria-label={labelFor('navPrimary')}
      className={cn(
        // overflow-y-auto: six items, the add button and the locale switch
        // stand ~560px tall; a shorter desktop window scrolls the rail
        // instead of clipping its foot.
        'flex w-[76px] shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-line bg-surface py-4',
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
            className="mt-2 flex flex-col items-center gap-1 rounded-md px-2 py-2 text-overline font-semibold text-ink-soft hover:bg-surface-2"
          >
            <span className="grid size-9 place-items-center rounded-full bg-accent text-on-accent shadow-xs">
              <Plus size={20} />
            </span>
            {labelFor('navAdd')}
          </Link>
        )}
      </div>
      <div className="mb-2 flex flex-col gap-1 border-t border-line pt-2">
        {NAV_MORE.filter((n) => clubs || n.href !== '/za-klubove').map((n) => (
          <NavRailItem key={n.key} item={n} active={n.href === active} label={labelFor(n.key)} />
        ))}
      </div>
      {/* Pinned to the rail's foot. A client component, so the rail itself
          stays hook-free and still renders in server and client trees alike. */}
      <LocaleSwitcher variant="rail" />
    </nav>
  );
}

function NavRailItem({ item, active, label }: { item: RailItem; active: boolean; label: string }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={`flex flex-col items-center gap-1 rounded-md px-2 py-2 text-center text-overline font-semibold leading-tight ${
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
      className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 self-stretch text-overline font-semibold ${
        active ? 'text-brand' : 'text-ink-soft'
      }`}
    >
      <Icon size={23} />
      {label}
    </Link>
  );
}

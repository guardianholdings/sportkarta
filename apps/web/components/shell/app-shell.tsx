import { getTranslations } from 'next-intl/server';

import { type ActiveHref, BottomNav, NavRail } from './app-nav';

/**
 * Page chrome for every non-map surface: the desktop nav rail on the left and
 * the mobile bottom tab bar, both linking back to the map (`/`). The map page
 * composes NavRail/BottomNav itself (its layout floats over the canvas);
 * everything else wraps its <main> in this shell so no screen is a dead end.
 *
 * The bottom bar is sticky within the shell, so it stays pinned while the
 * page scrolls and yields to the site footer at the very end.
 */
export async function AppShell({
  active = null,
  children,
}: {
  /** Which primary tab this page belongs to; null highlights nothing. */
  active?: ActiveHref | null;
  children: React.ReactNode;
}) {
  const t = await getTranslations('Nav');
  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      {/* First focusable element on every shell page — the map screen carries
          its own skip link to the facility list. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-pill focus:bg-surface focus:px-4 focus:py-2.5 focus:text-body-sm focus:font-semibold focus:text-brand focus:shadow-md"
      >
        {t('skipToContent')}
      </a>
      <NavRail active={active} labelFor={(k) => t(k)} className="sticky top-0 hidden h-dvh lg:flex" />
      <div className="flex min-w-0 flex-1 flex-col">
        {/*
          `pb-9` on mobile: the bottom bar's add-facility FAB is 54px and sits at
          `top-[-22px]`, so it protrudes 22px ABOVE the bar and over whatever the
          page ends with. On any short page that is the primary CTA — the FAB was
          covering the bottom strip of «Упъти ме» on /obekt and swallowing taps
          meant for it, routing them to /dobavi instead. Reserving the overhang
          here fixes it for every shell page at once rather than per screen.
        */}
        <div id="main-content" className="flex-1 pb-9 lg:pb-0">
          {children}
        </div>
        <BottomNav
          active={active}
          labelFor={(k) => t(k)}
          className="sticky bottom-0 z-40 lg:hidden"
        />
      </div>
    </div>
  );
}

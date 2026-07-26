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
      <NavRail active={active} labelFor={(k) => t(k)} className="sticky top-0 hidden h-dvh lg:flex" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1">{children}</div>
        <BottomNav
          active={active}
          labelFor={(k) => t(k)}
          className="sticky bottom-0 z-40 lg:hidden"
        />
      </div>
    </div>
  );
}

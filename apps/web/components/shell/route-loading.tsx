import { getTranslations } from 'next-intl/server';

import { AppShell } from '@/components/shell/app-shell';
import { LoadingMark } from '@/components/shell/loading-mark';

/**
 * The route-segment loading screen: the animated „Усмивката" writing itself,
 * centred on brand paper. Every `loading.tsx` under app/[locale] re-exports
 * this, so a navigation that is still fetching shows the mark instead of a
 * frozen frame or a blank.
 *
 * WHERE THOSE FILES MAY LIVE is the whole design, not a detail. A loading file
 * wraps its segment in Suspense, and Next sends the 200 status line with the
 * first streamed byte — so a page below one can call notFound() all it likes
 * and still answer 200 with a "not found" body (a soft 404). The boundary used
 * to sit at app/[locale] and did exactly that to every facility, session,
 * campaign, passport and city URL. So loading screens live only on segments
 * whose pages cannot 404, and tests/route-boundaries.test.ts fails the build
 * the moment one lands above a notFound().
 *
 * INSIDE THE SHELL. The fallback replaces the page, and the page owns its
 * AppShell — so a full-screen mark here took the tab bar and the rail away on
 * every tab tap (all four tabs are dynamic) and put them back a moment later
 * (UX audit 2026-10-10). The mark now sits in the content area of the same
 * chrome; no tab is highlighted until the page itself says which one it is.
 */
export default async function RouteLoading() {
  const t = await getTranslations('Nav');
  return (
    <AppShell>
      <div className="grid min-h-[70dvh] place-items-center">
        <LoadingMark size={72} label={t('loading')} className="text-accent" />
      </div>
    </AppShell>
  );
}

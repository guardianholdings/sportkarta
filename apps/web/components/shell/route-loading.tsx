import { getTranslations } from 'next-intl/server';

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
 */
export default async function RouteLoading() {
  const t = await getTranslations('Nav');
  return (
    <div className="grid min-h-dvh place-items-center bg-paper">
      <LoadingMark size={88} label={t('loading')} className="text-accent" />
    </div>
  );
}

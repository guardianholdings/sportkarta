import { getTranslations } from 'next-intl/server';

import { LoadingMark } from '@/components/shell/loading-mark';

/**
 * The route-segment loading screen: the animated „Усмивката" writing itself,
 * centred on brand paper. This is the nearest `loading.tsx` for every page
 * under [locale], so any navigation whose segment is still fetching shows the
 * mark instead of a frozen frame or a blank.
 */
export default async function Loading() {
  const t = await getTranslations('Nav');
  return (
    <div className="grid min-h-dvh place-items-center bg-paper">
      <LoadingMark size={88} label={t('loading')} className="text-accent" />
    </div>
  );
}

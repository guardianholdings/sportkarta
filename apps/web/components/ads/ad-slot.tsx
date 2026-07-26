import { getDb } from '@sportkarta/db';
import { getLocale, getTranslations } from 'next-intl/server';

import { AdCreative } from '@/components/ads/ad-creative';
import { activeAd, adAlt, type AdSlotKey } from '@/lib/ads';

/**
 * One labelled advertising slot (docs/MONETISATION.md S5, phase M4).
 *
 * THIS COMPONENT IS WHY "NO CONSENT BANNER" IS TRUE, and that is not a
 * side-effect — it is the specification:
 *
 *   * NO CLIENT JS. A server component that renders an `<img>` and an `<a>`.
 *   * NO EXTERNAL REQUEST. The creative is streamed from our own storage by a
 *     row-decides route on our own origin; nothing is fetched from an ad
 *     network, and there is no pixel, beacon or iframe.
 *   * NOTHING STORED ON THE DEVICE. No cookie, no localStorage, no id.
 *   * SELECTED BY SURFACE, NEVER BY VIEWER. The only input is the slot key the
 *     page passes in, so this component cannot know who is reading — which is
 *     what makes the placement contextual rather than behavioural.
 *
 * Anybody changing this file so that it fetches, measures or personalises is
 * buying the AD-2 gate in §S5: a consent banner, third-party scripts, and a
 * rewrite of the privacy page's "не проследяваме потребителите".
 *
 * AN UNSOLD SLOT RENDERS NOTHING — not a placeholder, not a bordered box, not
 * "advertise here". A house ad in every empty slot would make the whole site
 * look like an ad surface for revenue that does not exist.
 *
 * WHERE IT MAY BE MOUNTED is the four surfaces in §S5's table and nowhere else.
 * Permanently excluded, each for its own reason: passport pages, `/obshtina`
 * accountability pages (a sponsor logo under the metrics that hold mayors
 * accountable), `/danni`, the embed widget (whose CSP forbids it anyway),
 * auth/admin, all e-mail, and the map CANVAS — `map_panel` is a card in the
 * list panel BESIDE the map, never on it.
 */
export async function AdSlot({ slot }: { slot: AdSlotKey }) {
  const ad = await activeAd(getDb(), slot);
  if (!ad) return null;

  const [t, locale] = await Promise.all([getTranslations('Ads'), getLocale()]);
  return (
    <AdCreative
      id={ad.id}
      url={ad.url}
      alt={adAlt(ad.altBg, ad.altEn, locale)}
      label={t('label')}
    />
  );
}

/** What a client surface needs, resolved on the server. */
export interface AdSlotProps {
  id: number;
  url: string;
  alt: string;
}

/**
 * The `map_panel` path: a SERVER page resolves the placement and passes this
 * plain object into the client map explorer, which renders `<AdCreative>`
 * itself. The fetch and the locale resolution stay on the server, so the client
 * bundle gains no database import and no ad logic — only three strings.
 */
export async function adSlotProps(slot: AdSlotKey): Promise<AdSlotProps | null> {
  const ad = await activeAd(getDb(), slot);
  if (!ad) return null;
  const locale = await getLocale();
  return { id: ad.id, url: ad.url, alt: adAlt(ad.altBg, ad.altEn, locale) };
}

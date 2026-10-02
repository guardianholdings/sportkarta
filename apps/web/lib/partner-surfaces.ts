import { revalidatePath } from 'next/cache';

/**
 * Every public page that shows partner content — an ad slot, the headline
 * strip, a facility adoption — named by its ROUTE, so one call reaches every
 * city and every facility without enumerating them.
 *
 * Two of them are cached for an hour (`/igrishta/[city]` and
 * `/sedmitsata/[city]` are ISR), and a cached page keeps whatever it rendered:
 * an ad, its «Реклама» label, its alt text and its link to the advertiser. So
 * EVERY write that changes what `PARTNER_RENDERABLE` or `activeAd` would answer
 * — a placement created, published or deleted, a partner hidden, its window or
 * tier edited, a new headline partner — revalidates all of them. Hiding a
 * partner withdraws them everywhere at once (CLAUDE.md), not when the hour
 * turns over. The pages that are rendered per request are listed too: a no-op
 * today, and already covered the day one of them is cached.
 *
 * The patterns are the ROUTE as the app directory spells it, `[locale]`
 * included: Next tags a cached page `/[locale]/igrishta/[city]/page`, and a
 * path written without the locale segment matches nothing — silently
 * (tests/caching-config.test.ts holds both properties).
 *
 * Server-only: the partner and ad action files are `'use server'` modules,
 * which may export nothing but actions, so the list lives here.
 */
export const PARTNER_SURFACES = [
  '/[locale]/obekt/[slug]',
  '/[locale]/igrishta/[city]',
  '/[locale]/sedmitsata/[city]',
  '/[locale]',
] as const;

export function revalidatePartnerSurfaces(): void {
  for (const path of PARTNER_SURFACES) revalidatePath(path, 'page');
}

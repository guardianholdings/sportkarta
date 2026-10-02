/**
 * The crowd-edit feed's query string, in one place so the page, its filters and
 * the redirect after a revert all agree. Bulgarian keys, like the rest of the
 * admin URLs: `akaunt` (one account), `chasa` (the last N hours), `predi`
 * (keyset page: edits older than this id).
 */

/** The windows the feed filters by and a bulk revert may cover. */
export const FEED_WINDOWS_HOURS = [1, 24, 168, 720] as const;
export const REVERT_WINDOWS_HOURS = FEED_WINDOWS_HOURS;

export interface FeedParams {
  akaunt?: string;
  chasa?: string;
  predi?: string;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseFeedParams(sp: Record<string, string | string[] | undefined>): FeedParams {
  const account = first(sp.akaunt)?.trim();
  const hours = first(sp.chasa);
  const before = first(sp.predi);
  return {
    // Account ids are opaque better-auth ids; anything longer is not one.
    ...(account && account.length <= 64 ? { akaunt: account } : {}),
    ...(hours && (FEED_WINDOWS_HOURS as readonly number[]).includes(Number(hours))
      ? { chasa: hours }
      : {}),
    ...(before && /^\d{1,18}$/.test(before) ? { predi: before } : {}),
  };
}

/** The feed URL for these filters plus any extra keys (a result banner, a page). */
export function feedHref(base: FeedParams, extra: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams();
  if (base.akaunt) params.set('akaunt', base.akaunt);
  if (base.chasa) params.set('chasa', base.chasa);
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return query ? `/admin/redakcii?${query}` : '/admin/redakcii';
}

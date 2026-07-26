/**
 * In-memory micro-cache for the embeddable widget (Stage 6 hardening).
 *
 * WHY THIS EXISTS: the widget's Cache-Control advertises s-maxage, but nothing
 * in the stack honours it — Caddy is a plain reverse proxy, not a cache — so
 * before this module every visitor of every embedding municipal homepage ran
 * the accountability queries against Postgres. An embed on one popular page
 * was a standing load test we didn't schedule. Same philosophy as the
 * open-data rate limiter: in-memory, per process, allowed to forget.
 *
 * STALE-WHILE-ERROR is the actual hardening: the route's own header promises
 * "a municipality's homepage must not go down because ours is redeploying".
 * When the load fails (deploy, DB restart), a stale copy — up to a day old,
 * for numbers that move on the scale of days — keeps the embed alive; only a
 * cold process with no copy at all degrades to a 503.
 *
 * Bounded by construction: keys are municipality slugs (≤265), values are the
 * aggregate-only accountability payloads. No eviction pressure to manage.
 */

interface Entry<T> {
  value: T;
  freshUntil: number;
  staleUntil: number;
}

export const WIDGET_FRESH_MS = 5 * 60_000;
export const WIDGET_STALE_MS = 24 * 60 * 60_000;

const store = new Map<string, Entry<unknown>>();

export interface CachedResult<T> {
  value: T;
  /** True when this is a stale copy served because the load failed. */
  degraded: boolean;
}

export async function widgetCached<T>(
  key: string,
  load: () => Promise<T>,
  now: number = Date.now(),
): Promise<CachedResult<T> | null> {
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.freshUntil > now) return { value: hit.value, degraded: false };

  try {
    const value = await load();
    store.set(key, {
      value,
      freshUntil: now + WIDGET_FRESH_MS,
      staleUntil: now + WIDGET_STALE_MS,
    });
    // Opportunistic prune — entries past their stale window are useless even
    // as a fallback, and this keeps the map from holding deleted cities.
    for (const [k, entry] of store) {
      if (entry.staleUntil <= now) store.delete(k);
    }
    return { value, degraded: false };
  } catch (error: unknown) {
    // The message, never the error object: a pg connection error can embed the
    // connection string (the actions.ts precedent).
    console.error(
      '[widget] accountability load failed:',
      error instanceof Error ? error.message : 'unknown',
    );
    if (hit && hit.staleUntil > now) return { value: hit.value, degraded: true };
    return null;
  }
}

/** Test hook. */
export function clearWidgetCache(): void {
  store.clear();
}

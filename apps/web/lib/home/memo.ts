/**
 * Per-process memo for the front page's aggregates.
 *
 * The front page is rendered per request (it greets a signed-in member), but
 * nothing on it except that greeting changes faster than every few minutes:
 * counts of facilities, of contributions, of this week's sessions. Caddy is a
 * plain reverse proxy, so without this every visitor of the busiest page on
 * the site would re-run the same aggregates — the widget-cache precedent.
 *
 * Bounded by construction: keys are a section name plus at most a sport slug
 * and a locale. A load that fails while an older copy exists serves the older
 * copy (numbers that move on the scale of hours); with no copy it throws, and
 * the page leaves that section out (`orNull`) rather than failing whole.
 * Concurrent misses share one load.
 */

interface Entry<T> {
  value: T;
  freshUntil: number;
}

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

function message(error: unknown): string {
  // The message, never the error object: a pg connection error can embed the
  // connection string (the widget-cache precedent).
  return error instanceof Error ? error.message : 'unknown';
}

export async function homeCached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.freshUntil > Date.now()) return hit.value;
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const next = load()
    .then((value) => {
      store.set(key, { value, freshUntil: Date.now() + ttlMs });
      return value;
    })
    .catch((error: unknown) => {
      if (!hit) throw error;
      console.error(`[home] ${key} failed, serving the previous copy:`, message(error));
      return hit.value;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, next);
  return next;
}

/** A section's data, or null when it could not be loaded — the page renders without it. */
export async function orNull<T>(label: string, load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error: unknown) {
    console.error(`[home] ${label} failed:`, message(error));
    return null;
  }
}

/** Test hook. */
export function clearHomeCache(): void {
  store.clear();
  inflight.clear();
}

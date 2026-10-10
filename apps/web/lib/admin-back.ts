import { isSafeRedirect } from './safe-redirect';

/**
 * Where an admin editor's back link leads: the list the operator came from,
 * with its filters and page (UX audit 2026-10-10, A-9). «← Всички съоръжения»
 * used to open the unfiltered first page, so working through «чака проверка» in
 * one municipality meant re-filtering after every facility.
 *
 * It travels as `?back=`, so it is untrusted input: accepted only as an in-site
 * path (lib/safe-redirect.ts) that is `list` itself or `list` plus a query —
 * never another screen, never another origin. It carries no locale prefix;
 * the i18n Link adds the current one.
 */
export function safeAdminBack(value: unknown, list: string): string | null {
  if (typeof value !== 'string' || value.length > 512 || !isSafeRedirect(value)) return null;
  return value === list || value.startsWith(`${list}?`) ? value : null;
}

/** `list?query` for a set of query parameters, empty ones dropped. */
export function listHref(list: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const search = params.toString();
  return search ? `${list}?${search}` : list;
}

/**
 * Carrying what a member typed across a forced reload (B2).
 *
 * A form left open across a deploy can't send any more: the server no longer
 * knows its action (lib/form-action-failure.ts, `stale_form`), and only a reload
 * fixes that. Before reloading, the form keeps a copy of its fields in
 * sessionStorage (this tab only, gone when the tab closes) and puts them back
 * once, after the new page has hydrated.
 *
 * Only an ALLOWLIST of names per form travels:
 * - never a file: a picked photo can't be kept (FormRecovery.photoAgain says so);
 * - never the member's own GPS fix (positionLat/positionLon): it is the proof of
 *   being on the spot, so it is shared again rather than replayed;
 * - never a hidden field the new page has to issue itself, or Next's own
 *   `$ACTION_*` fields.
 * Everything here is pure, so the tests can reach it; the storage and the
 * reload live in the client hook that calls it.
 */

export type RecoveredEntries = [name: string, value: string][];

export const FORM_RECOVERY_VERSION = 1;

/** A copy older than this is dropped: the member has moved on. */
export const FORM_RECOVERY_TTL_MS = 10 * 60 * 1000;

/** The entries worth carrying across the reload, in form order. */
export function pickEntries(
  entries: Iterable<[string, FormDataEntryValue]>,
  allow: readonly string[],
): RecoveredEntries {
  const kept: RecoveredEntries = [];
  for (const [name, value] of entries) {
    if (typeof value !== 'string') continue;
    if (!allow.includes(name)) continue;
    kept.push([name, value]);
  }
  return kept;
}

export function encodeRecovery(entries: RecoveredEntries, now: number): string {
  return JSON.stringify({ v: FORM_RECOVERY_VERSION, at: now, entries });
}

/**
 * The stored copy, or null when there is none, it is broken, from another
 * version, or too old. Filters through the allowlist again on the way in.
 */
export function decodeRecovery(
  raw: string | null,
  now: number,
  allow: readonly string[],
): RecoveredEntries | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { v, at, entries } = parsed as { v?: unknown; at?: unknown; entries?: unknown };
  if (v !== FORM_RECOVERY_VERSION || typeof at !== 'number' || !Array.isArray(entries)) return null;
  if (now - at > FORM_RECOVERY_TTL_MS) return null;
  return entries.filter(
    (entry): entry is [string, string] =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === 'string' &&
      typeof entry[1] === 'string' &&
      allow.includes(entry[0]),
  );
}

/** One copy per form and page, so two tabs on two facilities don't mix. */
export function recoveryKey(form: string, pathname: string): string {
  return `pops:form-recovery:${form}:${pathname}`;
}

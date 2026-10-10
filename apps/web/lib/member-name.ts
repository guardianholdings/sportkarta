/**
 * A member's display name as it renders, or `fallback` when there is none.
 *
 * WHY NOT `name ?? fallback`. Signing up with an email code creates the account
 * with `display_name = ''` — the column is NOT NULL DEFAULT '' — so the nullish
 * fallback never fired: such a member appeared on the boards as an empty link,
 * on the roster as a blank row, and on their public passport under an empty
 * <h1> (UX audit 2026-10-10, S-1). Whitespace counts as no name, the same rule
 * the profile form applies before it saves one (lib/profile.ts).
 */
export function memberName(name: string | null | undefined, fallback: string): string {
  return name?.trim() || fallback;
}

/** Whether there is a name for other people to read — publishing a passport needs one. */
export function hasDisplayName(name: string | null | undefined): boolean {
  return Boolean(name?.trim());
}

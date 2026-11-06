/**
 * What the /klubove list area shows:
 *   - `clubs`: the clubs the filter found;
 *   - `noMatch`: «Няма клубове по тези критерии.», when a filter finds none
 *     while other clubs are published;
 *   - `emptyCatalogue`: no club is published at all, on a filtered link too,
 *     so the page invites the first one instead (operator, 2026-11-01: the
 *     no-match line under no filter read as a broken page).
 * `countAll` runs only when a filter found none, so a page with clubs costs
 * no second query.
 */
export type DirectoryView = 'clubs' | 'noMatch' | 'emptyCatalogue';

export async function directoryView(
  found: number,
  filtered: boolean,
  countAll: () => Promise<number>,
): Promise<DirectoryView> {
  if (found > 0) return 'clubs';
  if (!filtered) return 'emptyCatalogue';
  return (await countAll()) > 0 ? 'noMatch' : 'emptyCatalogue';
}

/**
 * Whether the page ends with its «Имате зала, студио или клуб?» box. The
 * invitation already carries the box's two buttons, so while it shows, the box
 * would repeat them one screen lower (operator, 2026-11-02).
 */
export function showsApplyBox(view: DirectoryView): boolean {
  return view !== 'emptyCatalogue';
}

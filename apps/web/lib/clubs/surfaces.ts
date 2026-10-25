import { revalidatePath } from 'next/cache';

/**
 * Every public page that shows a club, named by its ROUTE (the
 * partner-surfaces rule, apps/web/lib/partner-surfaces.ts): the club's own
 * page and class pages, the /klubove directory, the facility pages that carry
 * a club block, and the map (whose preview chip says «Клуб»). Any write that
 * changes what CLUB_RENDERABLE answers — publishing, a tier or paid-until
 * change, a suspension, a location linked to a facility, a new class —
 * revalidates all of them, so hiding or lapsing a club withdraws it everywhere
 * at once rather than when a cache turns over.
 */
export const CLUB_SURFACES = [
  '/[locale]/klub/[slug]',
  '/[locale]/klub/[slug]/trenirovka/[occurrenceId]',
  '/[locale]/klubove',
  '/[locale]/obekt/[slug]',
  '/[locale]/(map)',
] as const;

export function revalidateClubSurfaces(slug?: string): void {
  for (const path of CLUB_SURFACES) revalidatePath(path, 'page');
  if (slug) {
    revalidatePath(`/klub/${slug}`);
    revalidatePath(`/en/klub/${slug}`);
  }
}

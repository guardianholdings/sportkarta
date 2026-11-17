import { getTranslations } from 'next-intl/server';

import { facilityTitle, type LabelStrings } from '@/components/map/facility-label';
import type { ScopedFacility } from '@/lib/places';
import { breadcrumbList, type Crumb, graph, itemList } from '@/lib/structured-data';

import { JsonLd } from './json-ld';

/**
 * A place listing described for a machine: where the page sits, and the rows
 * it shows, in the order it shows them.
 *
 * The rows are named by the SAME function the visible list uses
 * (components/places/facility-list.tsx → facility-label.ts), so an unnamed
 * pitch is «Футбол» here exactly as it is on the page, never one more
 * identical «Спортно съоръжение» — and never a name the page does not print.
 *
 * `total` is the whole listing; `facilities` is the slice on this page.
 */
export async function ListingData({
  locale,
  name,
  trail,
  facilities,
  total,
}: {
  locale: string;
  /** The listing's own heading. */
  name: string;
  /** The crumbs after the site itself, ending with this page. */
  trail: Crumb[];
  facilities: ScopedFacility[];
  total: number;
}) {
  const [tSport, tFacility, tManifest] = await Promise.all([
    getTranslations({ locale, namespace: 'Sport' }),
    getTranslations({ locale, namespace: 'Facility' }),
    getTranslations({ locale, namespace: 'Manifest' }),
  ]);
  const labels: LabelStrings = {
    locale,
    unnamed: tFacility('unnamed'),
    sport: (sport) => tSport(sport),
    unnamedAt: (what, place) => tFacility('unnamedAt', { what, place }),
  };

  return (
    <JsonLd
      data={graph(
        breadcrumbList([{ name: tManifest('shortName'), path: '/' }, ...trail], locale),
        itemList({
          name,
          total,
          locale,
          items: facilities.map((facility) => ({
            name: facilityTitle({ name: facility.name, sports: facility.sportTypes }, labels),
            path: `/obekt/${facility.slug}`,
          })),
        }),
      )}
    />
  );
}

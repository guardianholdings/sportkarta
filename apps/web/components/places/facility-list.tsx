import { getLocale, getTranslations } from 'next-intl/server';

import {
  facilitySubtitle,
  facilityTitle,
  type LabelStrings,
} from '@/components/map/facility-label';
import { Link } from '@/i18n/navigation';
import type { ScopedFacility } from '@/lib/places';

/** SSR list of facilities (links to /obekt/[slug]) shared by the place pages. */
export async function FacilityList({ facilities }: { facilities: ScopedFacility[] }) {
  const [tSport, tFacility, locale] = await Promise.all([
    getTranslations('Sport'),
    getTranslations('Facility'),
    getLocale(),
  ]);
  // The same naming the map uses (components/map/facility-label.ts), so an
  // unnamed row reads by its sport rather than as one more identical «Спортно
  // съоръжение». No place is passed: every row here is in the place the page is
  // about, and repeating it on each line would tell the rows apart no better.
  const labels: LabelStrings = {
    locale,
    unnamed: tFacility('unnamed'),
    sport: (sport) => tSport(sport),
    unnamedAt: (what, place) => tFacility('unnamedAt', { what, place }),
  };

  return (
    <ul className="divide-y divide-line overflow-hidden rounded-card border border-line">
      {facilities.map((f) => {
        const source = { name: f.name, sports: f.sportTypes };
        const name = facilityTitle(source, labels);
        const sports = facilitySubtitle(source, labels);
        // The link's accessible name is otherwise the flattened text of both
        // spans with no separator ("Спортно съоръжениетенис"); an explicit label
        // keeps name and sports as distinct, readable tokens for a screen reader.
        const label = sports ? `${name} — ${sports}` : name;
        return (
          <li key={f.slug}>
            <Link
              href={`/obekt/${f.slug}`}
              aria-label={label}
              className="block px-4 py-3 hover:bg-paper-sunk"
            >
              <span className="font-medium">{name}</span>
              {sports && <span className="block text-caption text-text-muted">{sports}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

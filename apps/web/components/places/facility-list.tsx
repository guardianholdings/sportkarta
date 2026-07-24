import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import type { ScopedFacility } from '@/lib/places';

/** SSR list of facilities (links to /obekt/[slug]) shared by the place pages. */
export async function FacilityList({ facilities }: { facilities: ScopedFacility[] }) {
  const [tSport, tFacility] = await Promise.all([
    getTranslations('Sport'),
    getTranslations('Facility'),
  ]);

  return (
    <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
      {facilities.map((f) => {
        const name = f.name ?? tFacility('unnamed');
        const sports = f.sportTypes.slice(0, 3).map((s) => tSport(s));
        // The link's accessible name is otherwise the flattened text of both
        // spans with no separator ("Спортно съоръжениетенис"); an explicit label
        // keeps name and sports as distinct, readable tokens for a screen reader.
        const label = sports.length > 0 ? `${name} — ${sports.join(', ')}` : name;
        return (
          <li key={f.slug}>
            <Link
              href={`/obekt/${f.slug}`}
              aria-label={label}
              className="block px-4 py-3 hover:bg-neutral-50"
            >
              <span className="font-medium">{name}</span>
              {sports.length > 0 && (
                <span className="block text-xs text-neutral-500">{sports.join(' · ')}</span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

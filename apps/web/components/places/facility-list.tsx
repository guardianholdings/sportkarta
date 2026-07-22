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
      {facilities.map((f) => (
        <li key={f.slug}>
          <Link href={`/obekt/${f.slug}`} className="block px-4 py-3 hover:bg-neutral-50">
            <span className="font-medium">{f.name ?? tFacility('unnamed')}</span>
            {f.sportTypes.length > 0 && (
              <span className="block text-xs text-neutral-500">
                {f.sportTypes
                  .slice(0, 3)
                  .map((s) => tSport(s))
                  .join(' · ')}
              </span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

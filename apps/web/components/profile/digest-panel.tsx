import { getTranslations } from 'next-intl/server';

import { setDigestSubscriptionAction } from '@/app/[locale]/profil/actions';
import { Link } from '@/i18n/navigation';
import { cityDisplayName } from '@/lib/city-names';
import type { City } from '@/lib/places';

/**
 * Weekly-digest opt-in, one toggle per city (docs/ROADMAP.md §6, Stage 4.4).
 *
 * Plain forms rather than a client component: the whole panel is three buttons
 * and it must work before hydration. Each button posts the target state rather
 * than "flip it", so a double tap settles instead of flapping.
 */
export async function DigestPanel({
  locale,
  cities,
  subscribedIds,
}: {
  locale: string;
  cities: City[];
  subscribedIds: Set<number>;
}) {
  const t = await getTranslations('Digest');

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{t('subscribe')}</h2>
      {cities.length === 0 && <p className="text-sm text-neutral-500">{t('noCities')}</p>}
      <ul className="divide-y divide-neutral-100">
        {cities.map((city) => {
          const subscribed = subscribedIds.has(city.id);
          const name = cityDisplayName(city.nameBg, city.nameEn, locale);
          return (
            <li key={city.id} className="flex items-center gap-3 py-2">
              <Link href={`/sedmitsata/${city.slug}`} className="flex-1 underline">
                {name}
              </Link>
              <form action={setDigestSubscriptionAction}>
                <input type="hidden" name="municipalityId" value={city.id} />
                <input type="hidden" name="subscribed" value={subscribed ? 'false' : 'true'} />
                <button
                  type="submit"
                  className={
                    subscribed
                      ? 'rounded border border-neutral-300 px-3 py-1.5 text-sm'
                      : 'rounded bg-neutral-900 px-3 py-1.5 text-sm text-white'
                  }
                >
                  {subscribed ? t('optOut') : t('optIn')}
                </button>
              </form>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

import { getTranslations } from 'next-intl/server';

import { setDigestSubscriptionAction } from '@/app/[locale]/profil/actions';
import { Link } from '@/i18n/navigation';
import { ANALYTICS_EVENTS } from '@/lib/analytics-events';
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
    <section className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
      <h2 className="t-overline">{t('subscribe')}</h2>
      {cities.length === 0 && <p className="text-body-sm text-text-muted">{t('noCities')}</p>}
      <ul className="divide-y divide-line">
        {cities.map((city) => {
          const subscribed = subscribedIds.has(city.id);
          const name = cityDisplayName(city.nameBg, city.nameEn, locale);
          return (
            <li key={city.id} className="flex items-center gap-3 py-2">
              {/* C1: the ONLY inbound link to /sedmitsata anywhere in the
                  product — it has no nav entry and no index route. This is the
                  baseline that A6's unburying has to beat; without it, "the
                  weekly page is buried" and "unburying worked" are both
                  unfalsifiable. */}
              <Link
                href={`/sedmitsata/${city.slug}`}
                className="flex-1 truncate text-body-sm font-medium text-link hover:text-link-hover"
                data-umami-event={ANALYTICS_EVENTS.weeklyOpen}
              >
                {name}
              </Link>
              <form action={setDigestSubscriptionAction}>
                <input type="hidden" name="municipalityId" value={city.id} />
                <input type="hidden" name="subscribed" value={subscribed ? 'false' : 'true'} />
                <button
                  type="submit"
                  className={
                    subscribed
                      ? 'rounded-pill border border-line-strong bg-surface px-3 py-1.5 text-caption font-semibold text-ink-soft hover:bg-surface-2'
                      : 'rounded-pill bg-brand px-3 py-1.5 text-caption font-semibold text-on-brand hover:bg-brand-hover'
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

import { getDb, leaderboard, leaderboardCities, memberStanding } from '@sportkarta/db';
import { CANONICAL_SPORTS } from '@sportkarta/lib/sports';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { LeaderboardTable } from '@/components/passport/leaderboard-table';
import { getCurrentUser } from '@/lib/auth-session';
import { resolveScope, scopeHref } from '@/lib/leaderboard';
import { cityDisplayName, loadCityCatalog } from '@/lib/places';
import { Link } from '@/i18n/navigation';

/**
 * Public leaderboards — national, per city, per sport (docs/ROADMAP.md §7,
 * Stage 5.2).
 *
 * WHO IS ON IT is decided by `leaderboard_eligible_members` (migration 0011),
 * not by this page: not a minor (binding legal constant), and has opted their
 * passport public. This page cannot widen that and neither can a future one.
 *
 * NOINDEX, like the passports it links to. The board publishes names to people
 * who visit the site; indexing it would publish them against their name in a
 * search engine, which is a different decision that nobody has made. Making the
 * passports noindex and then listing all of them on an indexed page would
 * simply undo 0010.
 */
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Leaderboard' });
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LeaderboardPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: SearchParams;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  // Sport labels come from the existing `Sport` namespace rather than a
  // duplicate set of 28 keys under `Leaderboard` — two catalogues of the same
  // vocabulary drift, and the map filters already own this one.
  const [t, sportName] = await Promise.all([
    getTranslations('Leaderboard'),
    getTranslations('Sport'),
  ]);
  const query = await searchParams;

  const resolved = await resolveScope({
    grad: first(query.grad),
    sport: first(query.sport),
    period: first(query.period),
  });
  const { scope, period } = resolved;

  const [entries, catalog, rankedCityIds, user] = await Promise.all([
    leaderboard(getDb(), { scope, period, limit: 50 }),
    loadCityCatalog(),
    leaderboardCities(getDb()),
    getCurrentUser(),
  ]);

  // Only cities that actually have somebody ranked get a filter link — an empty
  // board behind every one of 265 municipality links is a worse page than a
  // short list of the ones with something on them.
  const cities = rankedCityIds
    .map((row) => catalog.byId.get(row.municipalityId))
    .filter((city): city is NonNullable<typeof city> => city !== undefined);

  const standing = user ? await memberStanding(getDb(), user.id, { scope, period }) : null;

  const heading = resolved.city
    ? t('headingCity', {
        city: cityDisplayName(resolved.city.nameBg, resolved.city.nameEn, locale),
      })
    : resolved.sport
      ? t('headingSport', { sport: sportName(resolved.sport) })
      : t('headingNational');

  const filterClass = (active: boolean): string =>
    active
      ? 'rounded bg-neutral-900 px-2.5 py-1 text-xs text-white'
      : 'rounded border border-neutral-300 px-2.5 py-1 text-xs';

  return (
    <main className="mx-auto max-w-2xl space-y-8 p-4">
      <header className="space-y-2 border-b border-neutral-200 pb-3">
        <h1 className="text-xl font-semibold">{heading}</h1>
        <p className="text-sm text-neutral-600">{t('intro')}</p>
      </header>

      <nav aria-label={t('filtersLabel')} className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Link href={scopeHref({ period })} className={filterClass(scope.kind === 'national')}>
            {t('scopeNational')}
          </Link>
          {cities.map((city) => (
            <Link
              key={city.id}
              href={scopeHref({ citySlug: city.slug, period })}
              className={filterClass(resolved.city?.id === city.id)}
            >
              {cityDisplayName(city.nameBg, city.nameEn, locale)}
            </Link>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          {CANONICAL_SPORTS.map((sport) => (
            <Link
              key={sport}
              href={scopeHref({ sport, period })}
              className={filterClass(resolved.sport === sport)}
            >
              {sportName(sport)}
            </Link>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <Link
            href={scopeHref({
              citySlug: resolved.city?.slug ?? null,
              sport: resolved.sport,
              period: 'all_time',
            })}
            className={filterClass(period === 'all_time')}
          >
            {t('periodAllTime')}
          </Link>
          <Link
            href={scopeHref({
              citySlug: resolved.city?.slug ?? null,
              sport: resolved.sport,
              period: 'month',
            })}
            className={filterClass(period === 'month')}
          >
            {t('periodMonth')}
          </Link>
        </div>
      </nav>

      <LeaderboardTable entries={entries} />

      <section className="space-y-2 rounded border border-neutral-200 p-4 text-sm">
        <h2 className="font-semibold">{t('yourStandingTitle')}</h2>
        {!user && <p className="text-neutral-600">{t('standingSignedOut')}</p>}
        {user && standing && (
          <p className="text-neutral-600">
            {t('standingRanked', {
              rank: standing.rank,
              total: standing.total,
              points: standing.points,
            })}
          </p>
        )}
        {/*
          The two reasons somebody is not ranked are different in kind, and the
          page says which. A minor is not "missing a setting" — the rule is not
          something they can opt into, and offering them a toggle that silently
          does nothing would be worse than saying so.
        */}
        {user && !standing && user.isMinor && (
          <p className="text-neutral-600">{t('standingMinor')}</p>
        )}
        {user && !standing && !user.isMinor && (
          <p className="text-neutral-600">
            {t('standingNotPublic')}{' '}
            <Link href="/pasport" className="underline">
              {t('standingPassportLink')}
            </Link>
          </p>
        )}
      </section>

      <p className="text-xs text-neutral-500">{t('eligibilityNote')}</p>
    </main>
  );
}

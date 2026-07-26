import {
  getDb,
  leaderboard,
  leaderboardCities,
  memberDivision,
  memberStanding,
  weekStandings,
} from '@sportkarta/db';
import { divisionWeekStart } from '@sportkarta/lib/divisions';
import { CANONICAL_SPORTS } from '@sportkarta/lib/sports';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { DivisionLadder } from '@/components/passport/division-ladder';
import { LeaderboardTable } from '@/components/passport/leaderboard-table';
import { getCurrentUser } from '@/lib/auth-session';
import { resolveScope, scopeHref } from '@/lib/leaderboard';
import { cityDisplayName, loadCityCatalog } from '@/lib/places';
import { Link } from '@/i18n/navigation';
import { AppShell } from '@/components/shell/app-shell';

/**
 * Public leaderboards — national, per city, per sport (docs/ROADMAP.md §7,
 * Stage 5.2).
 *
 * WHO IS ON IT is decided by `leaderboard_eligible_members` (migration 0011,
 * amended by 0020), not by this page: members who opted their passport public,
 * at any age. This page cannot widen that and neither can a future one.
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

  /**
   * The member's own division, and the ladder for it (T4/T6).
   *
   * It leads the page when it exists, which is what "divisions become the
   * default view" means here — no toggle and no new URL parameter, because a
   * toggle would have to be threaded through every filter link below and would
   * give a signed-out visitor a control that does nothing for them.
   *
   * Three ways this is absent, all rendering the overall board alone: signed
   * out, not assigned (a new member, or one who has not scored inside the
   * activity window), or the whole week is below the floor and has no groups.
   */
  const week = divisionWeekStart();
  const myDivision = user ? await memberDivision(getDb(), user.id, week) : null;
  const ladder = myDivision
    ? await weekStandings(getDb(), week, { groupId: myDivision.groupId })
    : [];

  const heading = resolved.city
    ? t('headingCity', { city: cityDisplayName(resolved.city.nameBg, resolved.city.nameEn, locale) })
    : resolved.sport
      ? t('headingSport', { sport: sportName(resolved.sport) })
      : t('headingNational');

  const filterClass = (active: boolean): string =>
    active
      ? 'rounded-pill bg-brand px-2.5 py-1 text-caption font-semibold text-on-brand'
      : 'rounded border border-line-strong px-2.5 py-1 text-xs';

  return (
    <AppShell active="/klasirane">
      <main className="mx-auto max-w-2xl space-y-8 p-4">
      <header className="space-y-2 border-b border-line pb-3">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{heading}</h1>
        <p className="text-body-sm text-ink-soft">{t('intro')}</p>
      </header>

      {/*
        The division leads, and renders nothing at all when the member has none.
        `DivisionLadder` highlights the viewer's own row, which is why the
        "your standing" card below is suppressed while it is showing: one
        self-reference per page, not two saying different things.
      */}
      <DivisionLadder rows={ladder} viewerUserId={user?.id ?? null} />

      {ladder.length > 0 && (
        <h2 className="border-t border-line pt-6 text-h3 font-extrabold tracking-tight text-ink">
          {t('nationalSectionTitle')}
        </h2>
      )}

      <nav aria-label={t('filtersLabel')} className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Link
            href={scopeHref({ period })}
            className={filterClass(scope.kind === 'national')}
          >
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

      {ladder.length === 0 && (
        <section className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-sm text-body-sm">
          <h2 className="font-semibold">{t('yourStandingTitle')}</h2>
          {!user && <p className="text-ink-soft">{t('standingSignedOut')}</p>}
          {user && standing && (
            <p className="text-ink-soft">
              {t('standingRanked', {
                rank: standing.rank,
                total: standing.total,
                points: standing.points,
              })}
            </p>
          )}
          {/*
            There is now ONE reason to be unranked — the passport is not public —
            and it is something the member can change, so the copy points at the
            control. The second branch that used to be here told minors the rule
            did not apply to them; migration 0020 removed the rule.
          */}
          {user && !standing && (
            <p className="text-ink-soft">
              {t('standingNotPublic')}{' '}
              <Link href="/pasport" className="font-medium text-link hover:text-link-hover">
                {t('standingPassportLink')}
              </Link>
            </p>
          )}
        </section>
      )}

      <p className="text-caption text-text-muted">{t('eligibilityNote')}</p>
      </main>
    </AppShell>
  );
}

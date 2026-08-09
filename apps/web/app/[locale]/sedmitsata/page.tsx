import { getDb } from '@sportkarta/db';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { AppShell } from '@/components/shell/app-shell';
import { ANALYTICS_EVENTS } from '@/lib/analytics-events';
import { weeklyCities } from '@/lib/digest';
import { loadCityCatalog, type City } from '@/lib/places';
import { buildAlternates } from '@/lib/seo';
import { Link } from '@/i18n/navigation';

/**
 * The city picker for the weekly programme (A6).
 *
 * WHY THIS EXISTS. `/sedmitsata/[city]` shipped with no index, so the only way
 * in was the link in the profile digest panel — behind `requireUser()`. A page
 * built to be forwarded and shared was reachable only by people already signed
 * in, and by anyone who still had the email. This is the missing front door.
 *
 * NOT CACHED, deliberately. `/sedmitsata/[city]` can carry `revalidate` because
 * it has no `generateStaticParams`, so nothing is prerendered at build time. An
 * INDEX has no params at all: adding `revalidate` here would make Next prerender
 * it during `next build`, which runs in the Docker image with no database
 * reachable — the build would fail, or worse, bake an empty city list into the
 * image. Dynamic rendering also means the list is never stale about which
 * cities have programming, which for a page about THIS week is the point.
 *
 * LISTS ONLY CITIES WITH PROGRAMMING THIS WEEK. There are 265 municipalities; a
 * list of all of them is not a choice, it is a wall (the same reasoning
 * `digestCities` states). A city with nothing on would lead to a weekly page
 * that renders empty, which is the burial complaint restated rather than fixed.
 */

export const dynamic = 'force-dynamic';

/** Same shape as the [city] page's local helper — one line, not worth a module. */
function cityName(city: City, locale: string): string {
  return locale === 'en' ? city.nameEn : city.nameBg;
}

type PageParams = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Digest' });
  return {
    title: t('indexTitle'),
    description: t('indexIntro'),
    alternates: buildAlternates('/sedmitsata', locale),
  };
}

export default async function WeeklyIndexPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const [t, cities, catalog] = await Promise.all([
    getTranslations('Digest'),
    weeklyCities(getDb()),
    loadCityCatalog(),
  ]);

  // Resolved through the catalogue rather than by joining names in SQL: that is
  // the single place a municipality becomes a slug, so an index cannot invent a
  // URL the [city] route would not recognise.
  const rows = cities
    .map((row) => ({ city: catalog.byId.get(row.id), sessions: row.sessions }))
    .filter((row): row is { city: NonNullable<typeof row.city>; sessions: number } =>
      Boolean(row.city),
    );

  return (
    <AppShell active="/sesii">
      <main className="mx-auto max-w-2xl px-4 py-5">
        <header className="mb-5">
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('indexTitle')}</h1>
          <p className="mt-1.5 text-body-sm text-ink-soft">{t('indexIntro')}</p>
        </header>

        {rows.length === 0 ? (
          // Nothing anywhere this week. Says so plainly and offers the way on,
          // rather than rendering an empty list that reads as a broken page.
          <div className="rounded-card border border-line bg-surface px-6 py-12 text-center shadow-sm">
            <p className="text-body-sm font-bold text-ink">{t('indexEmptyTitle')}</p>
            <p className="mx-auto mt-1 max-w-xs text-caption text-text-muted">
              {t('indexEmptyBody')}
            </p>
            <Link
              href="/sesii"
              className="mt-4 inline-flex h-9 items-center rounded-pill border border-line-strong bg-surface px-4 text-body-sm font-semibold text-ink-soft hover:bg-surface-2"
            >
              {t('indexAllSessions')}
            </Link>
          </div>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {rows.map(({ city, sessions }) => (
              <li key={city.id}>
                <Link
                  href={`/sedmitsata/${city.slug}`}
                  className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 shadow-sm hover:bg-surface-2"
                  data-umami-event={ANALYTICS_EVENTS.weeklyOpen}
                >
                  <span className="flex-1 truncate text-body-sm font-semibold text-ink">
                    {cityName(city, locale)}
                  </span>
                  <span className="font-mono text-caption tabular-nums text-text-secondary">
                    {t('indexSessions', { count: sessions })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </AppShell>
  );
}

import { getDb, weeklyDigest, type DigestOccurrence } from '@sportkarta/db';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { AdSlot } from '@/components/ads/ad-slot';
import { Link } from '@/i18n/navigation';
import { getCityBySlug, type City } from '@/lib/places';
import { buildAlternates } from '@/lib/seo';
import { AppShell } from '@/components/shell/app-shell';

/**
 * The auto-generated weekly city page (docs/ROADMAP.md §6, Stage 4.4).
 *
 * This page and the Monday digest email are the SAME QUERY — `weeklyDigest` in
 * `@sportkarta/db`, which exists precisely so the two cannot drift. What a
 * member reads in the mail is what they find when they follow the link.
 *
 * The week is a Sofia wall-clock Monday-to-Monday, so it stays aligned to
 * midnight through both DST transitions (see db/src/digest.ts).
 */

export const revalidate = 3600;

const SOFIA_TZ = 'Europe/Sofia';

type PageParams = Promise<{ locale: string; city: string }>;

function cityName(city: City, locale: string): string {
  return locale === 'en' ? city.nameEn : city.nameBg;
}

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, city: slug } = await params;
  const city = await getCityBySlug(slug);
  if (!city) return {};
  const t = await getTranslations({ locale, namespace: 'Digest' });
  const name = cityName(city, locale);
  const week = await weeklyDigest(getDb(), { municipalityId: city.id, timeZone: SOFIA_TZ });
  return {
    title: t('metaTitle', { city: name }),
    description: t('metaDescription', { city: name }),
    alternates: buildAlternates(`/sedmitsata/${city.slug}`, locale),
    // A week with nothing on is thin content, but the URL must stay stable —
    // it is in every digest email already sent. So: keep the page, drop it from
    // the index until there is something to see.
    ...(week.occurrences.length === 0 ? { robots: { index: false, follow: true } } : {}),
  };
}

function timeOf(startsAtLocal: string): string {
  return (startsAtLocal.split('T')[1] ?? '').slice(0, 5);
}

function dateOf(startsAtLocal: string): string {
  return startsAtLocal.split('T')[0] ?? '';
}

/** Group by local calendar day, preserving the query's ordering. */
function byDay(occurrences: DigestOccurrence[]): [string, DigestOccurrence[]][] {
  const days = new Map<string, DigestOccurrence[]>();
  for (const occurrence of occurrences) {
    const day = dateOf(occurrence.startsAtLocal);
    const bucket = days.get(day);
    if (bucket) bucket.push(occurrence);
    else days.set(day, [occurrence]);
  }
  return [...days.entries()];
}

export default async function WeeklyDigestPage({ params }: { params: PageParams }) {
  const { locale, city: slug } = await params;
  setRequestLocale(locale);

  const city = await getCityBySlug(slug);
  if (!city) notFound();

  const [t, tSport, week] = await Promise.all([
    getTranslations('Digest'),
    getTranslations('Sport'),
    weeklyDigest(getDb(), { municipalityId: city.id, timeZone: SOFIA_TZ }),
  ]);
  const name = cityName(city, locale);
  const weekdayFormat = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'bg-BG', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
  // week.weekStart is the ledger's civil YYYY-MM-DD; readers get a real date.
  const weekStartLabel = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'bg-BG', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${week.weekStart}T00:00:00Z`));

  return (
    <AppShell active="/sesii">
      <main className="mx-auto max-w-3xl space-y-6 p-4">
        <Link href="/" className="text-body-sm font-medium text-link hover:text-link-hover">
          {t('backToMap')}
        </Link>

        <header className="space-y-2">
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">
            {t('h1', { city: name })}
          </h1>
          <p className="text-body-sm text-text-muted">{t('weekOf', { date: weekStartLabel })}</p>
          {week.occurrences.length > 0 && (
            <p className="text-ink-soft">{t('intro', { count: week.occurrences.length })}</p>
          )}
        </header>

        {week.occurrences.length === 0 ? (
          <section className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-sm">
            <p className="text-ink-soft">{t('empty', { city: name })}</p>
            <p className="text-body-sm text-text-muted">{t('emptyHint')}</p>
            <Link
              href={`/igrishta/${city.slug}`}
              className="text-body-sm font-medium text-link hover:text-link-hover"
            >
              {t('backToMap')}
            </Link>
          </section>
        ) : (
          <div className="space-y-6">
            {byDay(week.occurrences).map(([day, entries]) => (
              <section key={day} aria-label={day}>
                <h2 className="mb-2 border-b border-line pb-1 text-h4 font-bold text-ink">
                  {/* The date is a civil date; parsing it as UTC and formatting in
                    UTC keeps it a calendar date and never shifts it.
                    first-letter, not `capitalize`: capitalizing every word turns
                    „понеделник, 10 август" into wrong-Bulgarian „…10 Август". */}
                  <span className="inline-block first-letter:uppercase">
                    {weekdayFormat.format(new Date(`${day}T00:00:00Z`))}
                  </span>
                </h2>
                <ul className="divide-y divide-line">
                  {entries.map((entry) => (
                    <li key={entry.occurrenceId} className="flex flex-wrap gap-x-3 gap-y-1 py-2">
                      <span className="w-12 shrink-0 font-mono text-body-sm tabular-nums">
                        {timeOf(entry.startsAtLocal)}
                      </span>
                      <span className="min-w-0 flex-1">
                        {/* Stage 4.2: the week is now a way in, not just a
                          listing — each entry leads to the page where you can
                          actually sign up. */}
                        <Link
                          href={`/sesiya/${entry.occurrenceId}`}
                          className="font-medium text-link hover:text-link-hover"
                        >
                          {entry.title}
                        </Link>
                        <span className="text-text-muted"> · {tSport(entry.sport)}</span>
                        {entry.facilityName && (
                          <span className="block text-body-sm text-ink-soft">
                            {entry.facilitySlug ? (
                              <Link
                                href={`/obekt/${entry.facilitySlug}`}
                                className="font-medium text-link hover:text-link-hover"
                              >
                                {entry.facilityName}
                              </Link>
                            ) : (
                              entry.facilityName
                            )}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 self-start text-body-sm text-text-muted">
                        {entry.capacity === null
                          ? t('spotsUnlimited', { going: entry.going })
                          : t('spots', { going: entry.going, capacity: entry.capacity })}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        <p className="border-t border-line pt-4 text-body-sm text-ink-soft">
          <Link href="/profil" className="font-medium text-link hover:text-link-hover">
            {t('subscribe')}
          </Link>
        </p>

        {/* MONETISATION §S5 ad surface: local, activity-minded audience. Renders
          nothing when the slot is unsold. */}
        <AdSlot slot="weekly_page" />
      </main>
    </AppShell>
  );
}

import { getDb, weeklyDigest, type DigestOccurrence } from '@sportkarta/db';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { Link } from '@/i18n/navigation';
import { getCityBySlug, type City } from '@/lib/places';
import { buildAlternates } from '@/lib/seo';

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

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-4">
      <Link href="/" className="text-sm underline">
        {t('backToMap')}
      </Link>

      <header className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">{t('h1', { city: name })}</h1>
        <p className="text-sm text-neutral-500">{t('weekOf', { date: week.weekStart })}</p>
        {week.occurrences.length > 0 && (
          <p className="text-neutral-700">{t('intro', { count: week.occurrences.length })}</p>
        )}
      </header>

      {week.occurrences.length === 0 ? (
        <section className="space-y-2 rounded border border-neutral-200 p-4">
          <p className="text-neutral-700">{t('empty', { city: name })}</p>
          <p className="text-sm text-neutral-500">{t('emptyHint')}</p>
          <Link href={`/igrishta/${city.slug}`} className="text-sm underline">
            {t('backToMap')}
          </Link>
        </section>
      ) : (
        <div className="space-y-6">
          {byDay(week.occurrences).map(([day, entries]) => (
            <section key={day} aria-label={day}>
              <h2 className="mb-2 border-b border-neutral-200 pb-1 text-lg font-semibold capitalize">
                {/* The date is a civil date; parsing it as UTC and formatting in
                    UTC keeps it a calendar date and never shifts it. */}
                {weekdayFormat.format(new Date(`${day}T00:00:00Z`))}
              </h2>
              <ul className="divide-y divide-neutral-100">
                {entries.map((entry) => (
                  <li key={entry.occurrenceId} className="flex flex-wrap gap-x-3 gap-y-1 py-2">
                    <span className="w-12 shrink-0 font-mono text-sm tabular-nums">
                      {timeOf(entry.startsAtLocal)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{entry.title}</span>
                      <span className="text-neutral-500"> · {tSport(entry.sport)}</span>
                      {entry.facilityName && (
                        <span className="block text-sm text-neutral-600">
                          {entry.facilitySlug ? (
                            <Link href={`/obekt/${entry.facilitySlug}`} className="underline">
                              {entry.facilityName}
                            </Link>
                          ) : (
                            entry.facilityName
                          )}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 self-start text-sm text-neutral-500">
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

      <p className="border-t border-neutral-200 pt-4 text-sm text-neutral-600">
        <Link href="/profil" className="underline">
          {t('subscribe')}
        </Link>
      </p>
    </main>
  );
}

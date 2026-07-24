import { CalendarDays, MapPin } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { FAMILY_COLOR, SPORT_FAMILY } from '@/lib/design/families';
import { SPORT_VISUALS } from '@/lib/design/sport-visuals';
import { listUpcomingSessions } from '@/lib/sessions/occurrence';
import { buildAlternates } from '@/lib/seo';
import { Link } from '@/i18n/navigation';
import type { CanonicalSport } from '@sportkarta/lib/sports';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Session' });
  return { title: t('indexTitle'), alternates: buildAlternates('/sesii', locale) };
}

/** wall-clock 'YYYY-MM-DDTHH:MM:SS' → [localized date, HH:MM] */
function whenParts(startsAtLocal: string, locale: string): [string, string] {
  const [date, time] = startsAtLocal.split('T');
  const d = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(
    new Date(`${date}T00:00:00`),
  );
  return [d, (time ?? '').slice(0, 5)];
}

export default async function SessionsIndexPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, tSport, sessions] = await Promise.all([
    getTranslations('Session'),
    getTranslations('Sport'),
    listUpcomingSessions(40),
  ]);

  return (
    <main className="mx-auto max-w-2xl px-4 py-5">
      <header className="mb-5">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('indexTitle')}</h1>
        <p className="mt-1.5 text-body-sm text-ink-soft">{t('indexIntro')}</p>
      </header>

      {sessions.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-card border border-line bg-surface px-6 py-14 text-center shadow-sm">
          <span className="grid size-12 place-items-center rounded-full bg-paper-sunk text-text-muted">
            <CalendarDays size={22} />
          </span>
          <div>
            <p className="text-body-sm font-bold text-ink">{t('indexEmptyTitle')}</p>
            <p className="mx-auto mt-1 max-w-xs text-caption text-text-muted">{t('indexEmptyBody')}</p>
          </div>
          <Link
            href="/"
            className="inline-flex h-9 items-center rounded-pill border border-line-strong bg-surface px-4 text-body-sm font-semibold text-ink-soft hover:bg-surface-2"
          >
            {t('indexViewMap')}
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {sessions.map((s) => {
            const fam = SPORT_FAMILY[s.sport as CanonicalSport];
            const color = fam ? FAMILY_COLOR[fam] : FAMILY_COLOR.multi;
            const Icon = s.sport in SPORT_VISUALS ? SPORT_VISUALS[s.sport as CanonicalSport].Icon : SPORT_VISUALS.multi.Icon;
            const [date, time] = whenParts(s.startsAtLocal, locale);
            return (
              <li key={s.occurrenceId}>
                <Link
                  href={`/sesiya/${s.occurrenceId}`}
                  className="flex items-center gap-3 rounded-card border border-line bg-surface p-3 shadow-sm transition-[box-shadow,border-color] duration-150 ease-standard hover:border-brand-border hover:shadow-md"
                >
                  <span
                    className="grid size-12 shrink-0 place-items-center rounded-md"
                    style={{ background: `color-mix(in srgb, ${color} 16%, var(--surface))`, color }}
                  >
                    <Icon size={22} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-sm font-bold text-ink">{s.title}</span>
                    <span className="mt-0.5 flex items-center gap-1 truncate text-caption text-text-muted">
                      <MapPin size={13} className="shrink-0" />
                      {s.facilityName ?? tSport(s.sport)}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-mono text-caption font-medium text-ink">{date}</span>
                    <span className="block font-mono text-caption tabular-nums text-brand">{time}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

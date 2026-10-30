import { getTranslations, setRequestLocale } from 'next-intl/server';

import { chipClass } from '@/components/ui/chip';
import { Link } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { clubSportLabeler } from '@/lib/clubs/labels';
import { clubRatings, ratedSports } from '@/lib/clubs/tournaments';

export const dynamic = 'force-dynamic';

/**
 * «Рейтинг» (0054): the club's own rating per sport — an Elo fold over the
 * results of its individual tournaments, derived on every visit and never
 * stored, so a corrected result corrects it. Office only (names are
 * members.view's); the public pages show no rating.
 */
export default async function ClubRatingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ sport?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'members.view');
  const [t, sportLabel, sports] = await Promise.all([
    getTranslations('ClubEvents.ratings'),
    clubSportLabeler(),
    ratedSports(actor),
  ]);
  const { sport: asked } = await searchParams;
  const sport = sports.find((s) => s === asked) ?? sports[0] ?? null;
  const rows = sport ? await clubRatings(actor, sport) : [];
  const base = `/klub/${slug}/sabitiya/reyting`;

  return (
    <main className="space-y-5">
      <Link
        href={`/klub/${slug}/sabitiya`}
        className="text-body-sm font-semibold text-link hover:text-link-hover"
      >
        ← {t('back')}
      </Link>
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1.5 max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
      </div>
      {sports.length > 1 && (
        <nav aria-label={t('title')} className="-mx-4 overflow-x-auto px-4">
          <ul className="flex gap-2 pb-1">
            {sports.map((value) => (
              <li key={value}>
                <Link
                  href={{ pathname: base, query: { sport: value } }}
                  aria-current={value === sport ? 'page' : undefined}
                  className={chipClass({ selected: value === sport, className: 'min-h-11' })}
                >
                  {sportLabel(value)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
        {rows.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('empty')}</p>
        ) : (
          <ol className="divide-y divide-line">
            {rows.map((row, i) => (
              <li
                key={row.memberId}
                className="flex items-baseline justify-between gap-3 py-2 text-body-sm"
              >
                <span className="min-w-0 text-ink">
                  <span className="mr-2 tabular-nums text-text-muted">{i + 1}.</span>
                  <Link
                    href={`/klub/${slug}/chlenove/${row.memberId}`}
                    className="font-semibold text-link hover:text-link-hover"
                  >
                    {row.name}
                  </Link>
                </span>
                <span className="text-ink-soft">
                  <span className="font-mono font-semibold tabular-nums text-ink">
                    {row.rating}
                  </span>
                  {' · '}
                  {t('played', { count: row.played })}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}

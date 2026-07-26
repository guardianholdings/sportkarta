import { getDb, memberParticipation, memberTrainings, trainingConsents } from '@sportkarta/db';
import { sql } from '@sportkarta/db';
import { buildShare, formatKm, formatMinutes } from '@sportkarta/lib/share';
import { CANONICAL_SPORTS } from '@sportkarta/lib/sports';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { ShareSheet } from '@/components/share/share-sheet';
import { AppShell } from '@/components/shell/app-shell';
import { TrainingForm } from '@/components/training/training-form';
import { requireUser } from '@/lib/auth-session';
import { siteUrl } from '@/lib/seo';
import { shareSheetStrings } from '@/lib/share/sheet-strings';
import {
  deleteTrainingAction,
  setTrainingConsentAction,
} from './actions';

/**
 * «Моите тренировки» — a member's own training log (operator request 2026-07-26).
 *
 * PRIVATE AND NOINDEX. Everything here is one person's own history, including
 * where and when they train; it is exactly the pattern-of-life record the rest
 * of the product refuses to publish, and it is safe to keep only because nobody
 * else can read it. `requireUser()` gates the page and every query below is
 * keyed by that id.
 *
 * The AGGREGATE of these rows is public — that is the participation board on
 * /klasirane — but a board is a count and this is a diary. The two are
 * deliberately different surfaces reading different queries.
 */
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Training' });
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

/** The member's own recent facilities, so the picker is short and relevant. */
async function nearbyFacilities(): Promise<{ id: string; name: string }[]> {
  const result = await getDb().execute(sql`
    SELECT id::text AS id, name
    FROM facilities
    WHERE status <> 'gone' AND name IS NOT NULL AND btrim(name) <> ''
    ORDER BY updated_at DESC
    LIMIT 100
  `);
  return result.rows.map((row) => ({ id: String(row.id), name: String(row.name) }));
}

export default async function TrainingPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requireUser();

  const [t, tShare, sportName, sheetWeek, sheetTraining] = await Promise.all([
    getTranslations('Training'),
    getTranslations('ShareSheet'),
    getTranslations('Sport'),
    shareSheetStrings('week'),
    shareSheetStrings('training'),
  ]);
  const origin = siteUrl();

  const [rows, totals, consents, facilities] = await Promise.all([
    memberTrainings(getDb(), user.id),
    memberParticipation(getDb(), user.id, { days: 30 }),
    trainingConsents(getDb(), user.id),
    nearbyFacilities(),
  ]);

  // Resolved server-side from the SAME list the form renders, so a sport can
  // never appear in the picker without a label — and the labels come from the
  // existing `Sport` namespace rather than a duplicate set of 29 keys, which is
  // what the leaderboard filters already do.
  const sportNames = Object.fromEntries(
    CANONICAL_SPORTS.map((slug) => [slug, sportName(slug)]),
  );

  const dateFormat = new Intl.DateTimeFormat(locale === 'bg' ? 'bg-BG' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Sofia',
  });

  // No `active` nav destination: the tab bar is already four items plus the add
  // FAB, and a fifth tab is a design change rather than a routing one.
  // /trenirovki is reached from /profil and from the participation board on
  // /klasirane — both covered by the reachability gate in e2e/crawl.spec.ts.
  return (
    <AppShell active={null}>
      <main className="mx-auto max-w-2xl space-y-8 p-4">
        <header className="space-y-2 border-b border-line pb-3">
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
          <p className="text-body-sm text-ink-soft">{t('intro')}</p>
        </header>

        <section className="grid grid-cols-3 gap-3">
          {(
            [
              ['statSessions', totals.sessions],
              ['statMinutes', totals.minutes],
              ['statSports', totals.sports],
            ] as const
          ).map(([key, value]) => (
            <div key={key} className="rounded-card border border-line bg-surface p-3 text-center">
              <p className="text-h3 font-extrabold tabular-nums text-ink">{value}</p>
              <p className="text-caption text-text-muted">{t(key)}</p>
            </div>
          ))}
        </section>

        {/*
          THE SUMMARY SHARE, directly under the numbers it describes. Offered
          only once there is something to say — a story of zeroes is the
          Wrapped-2024 failure in the other direction, and the story route 404s
          on it anyway.
        */}
        {totals.sessions > 0 && (
          <ShareSheet
            variant="primary"
            payload={buildShare({
              kind: 'week',
              locale,
              origin,
              page: '/klasirane',
              text: tShare('textWeek', { sessions: totals.sessions }),
            })}
            strings={sheetWeek}
          />
        )}

        <section className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
          <h2 className="text-h3 font-bold text-ink">{t('addTitle')}</h2>
          <TrainingForm
            sportNames={sportNames}
            facilities={facilities}
            strings={{
              sport: t('fieldSport'),
              startedAt: t('fieldStartedAt'),
              duration: t('fieldDuration'),
              durationHint: t('fieldDurationHint'),
              distanceKm: t('fieldDistance'),
              elevationM: t('fieldElevation'),
              facility: t('fieldFacility'),
              facilityNone: t('fieldFacilityNone'),
              note: t('fieldNote'),
              submit: t('submit'),
              saved: t('saved'),
              optional: t('optional'),
              problems: {
                sport_unknown: t('problems.sportUnknown'),
                duration_out_of_range: t('problems.duration'),
                distance_out_of_range: t('problems.distance'),
                elevation_out_of_range: t('problems.elevation'),
                started_at_invalid: t('problems.startedAtInvalid'),
                started_at_future: t('problems.startedAtFuture'),
                started_at_too_old: t('problems.startedAtTooOld'),
                note_too_long: t('problems.note'),
                external_id_on_manual: t('problems.external'),
                external_id_missing: t('problems.external'),
              },
            }}
          />
        </section>

        <section className="space-y-3">
          <h2 className="text-h3 font-bold text-ink">{t('listTitle')}</h2>
          {rows.length === 0 && <p className="text-body-sm text-ink-soft">{t('listEmpty')}</p>}
          {rows.length > 0 && (
            <ul className="divide-y divide-line rounded-card border border-line bg-surface">
              {rows.map((row) => (
                <li key={row.id} className="flex items-center gap-3 px-4 py-3 text-body-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink">
                      {sportName(row.sport)}
                      {row.facilityName && (
                        <span className="ml-2 font-normal text-text-muted">{row.facilityName}</span>
                      )}
                    </p>
                    <p className="text-caption text-text-muted">
                      {dateFormat.format(row.startedAt)} ·{' '}
                      {t('durationMinutes', { minutes: Math.round(row.durationS / 60) })}
                      {row.distanceM !== null &&
                        ` · ${t('distanceKm', { km: Math.round(row.distanceM / 100) / 10 })}`}
                    </p>
                  </div>
                  {/*
                    A share on EVERY row, not only the newest. The moment a
                    member wants to post is not always the moment they logged —
                    a good run is worth posting that evening too.
                  */}
                  <ShareSheet
                    size="sm"
                    payload={buildShare({
                      kind: 'training',
                      locale,
                      origin,
                      page: '/klasirane',
                      ref: row.id,
                      text: (() => {
                        const km = formatKm(row.distanceM);
                        const minutes = formatMinutes(row.durationS);
                        const sport = sportName(row.sport);
                        return km
                          ? tShare('textTrainingKm', { sport, km, minutes })
                          : tShare('textTraining', { sport, minutes });
                      })(),
                    })}
                    strings={sheetTraining}
                  />
                  <form action={deleteTrainingAction}>
                    <input type="hidden" name="id" value={row.id} />
                    <button
                      type="submit"
                      className="rounded border border-line-strong px-2 py-1 text-caption text-ink-soft hover:bg-paper-sunk"
                    >
                      {t('delete')}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/*
          The two connected-app consents. SEPARATE controls on purpose: a member
          may reasonably want their route stored and not their heart rate, and
          bundling two GDPR Art. 9 questions into one switch is what makes
          consent non-specific and therefore invalid. Each posts the TARGET
          state, so a double submission converges rather than flapping — and a
          flapping consent control is one that can leave data stored under a "no".
        */}
        <section className="space-y-3 rounded-card border border-line bg-paper-sunk p-4">
          <h2 className="text-h3 font-bold text-ink">{t('consentTitle')}</h2>
          <p className="text-body-sm text-ink-soft">{t('consentIntro')}</p>
          {(
            [
              ['route', consents.routeAt, t('consentRoute'), t('consentRouteBody')],
              ['health', consents.healthAt, t('consentHealth'), t('consentHealthBody')],
            ] as const
          ).map(([kind, at, label, body]) => (
            <form
              key={kind}
              action={setTrainingConsentAction}
              className="flex items-start justify-between gap-4 border-t border-line pt-3"
            >
              <div className="min-w-0">
                <p className="font-medium text-ink">{label}</p>
                <p className="text-caption text-ink-soft">{body}</p>
                {at && (
                  <p className="mt-1 text-caption text-text-muted">
                    {t('consentGrantedAt', { date: dateFormat.format(at) })}
                  </p>
                )}
              </div>
              <input type="hidden" name="kind" value={kind} />
              <input type="hidden" name="granted" value={at ? 'false' : 'true'} />
              <button
                type="submit"
                className="shrink-0 rounded-pill border border-line-strong px-3 py-1.5 text-body-sm font-medium hover:bg-surface"
              >
                {at ? t('consentWithdraw') : t('consentGrant')}
              </button>
            </form>
          ))}
          <p className="border-t border-line pt-3 text-caption text-text-muted">
            {t('consentWithdrawNote')}
          </p>
        </section>
      </main>
    </AppShell>
  );
}
